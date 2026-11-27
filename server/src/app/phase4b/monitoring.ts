import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.module';
import { appError, parseAppBody, type AppRequest } from '../common/app-http';
import { AppSettings } from '../common/app-settings';
import { AppRateLimiter } from '../common/rate-limit';
import { OutgoingMessages } from '../messages/outgoing-messages';
import { Phase4Gate } from '../phase4/common';

const uuid = new ParseUUIDPipe({ exceptionFactory: () => appError.notFound('Not found.') });

export const MONITORING_CONSENT_VERSION = '2026-11';

/** What the parent is told before turning Chhupa Rakshak on. Plain words, no hidden capture. */
export const MONITORING_NOTICE =
  'Chhupa Rakshak lets you see your linked child’s location for a short time during a safety concern. ' +
  'Your child’s phone always shows that a session is active, and your child can stop it. ' +
  'Only location is shared (no camera and no microphone). Every session is recorded and your child can see the history. ' +
  'It stops when you or your child stop it, when the link ends, or after the set time. ' +
  'It is not a way to watch someone in secret and it is not a 24/7 monitoring service.';

const consentBody = z.object({ enabled: z.boolean(), accept: z.boolean().default(false) });
const startBody = z.object({
  id: z.uuid(),
  reason: z.string().trim().min(5, { error: 'Say why (at least 5 characters)' }).max(200),
});
const sampleBody = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100000).nullish(),
});

interface SessionRow {
  id: string;
  link_id: string;
  status: string;
  end_reason: string | null;
  reason: string;
  started_at: Date;
  expires_at: Date;
  ended_at: Date | null;
}

const out = (s: SessionRow) => ({
  id: s.id,
  linkId: s.link_id,
  status: s.status,
  endReason: s.end_reason,
  reason: s.reason,
  startedAt: s.started_at.toISOString(),
  expiresAt: s.expires_at.toISOString(),
  endedAt: s.ended_at ? s.ended_at.toISOString() : null,
});

@Injectable()
export class MonitoringService {
  constructor(
    private readonly database: DatabaseService,
    private readonly settings: AppSettings,
    private readonly gate: Phase4Gate,
    private readonly messages: OutgoingMessages,
  ) {}

  private get db() {
    return this.database.db;
  }

  /** Ends sessions that ran out of time or whose family link is no longer active. */
  async sweep(): Promise<void> {
    await sql`
      UPDATE monitoring_sessions s
         SET status = CASE WHEN s.expires_at <= now() THEN 'expired' ELSE 'stopped' END,
             end_reason = CASE WHEN s.expires_at <= now() THEN 'expired' ELSE 'permission_lost' END,
             ended_at = now()
       WHERE s.status = 'active'
         AND (s.expires_at <= now()
              OR NOT EXISTS (SELECT 1 FROM child_links l WHERE l.id = s.link_id AND l.status = 'active'))`.execute(
      this.db,
    );
    const days = await this.settings.get('monitor.retention_days');
    await sql`DELETE FROM monitoring_samples
               WHERE recorded_at < now() - make_interval(days => ${days})`.execute(this.db);
  }

  private async parentLink(parentId: string, linkId: string) {
    const r = await sql<{ id: string; status: string; child_user_id: string | null; child_name: string }>`
      SELECT id, status, child_user_id, child_name FROM child_links
       WHERE id = ${linkId} AND parent_user_id = ${parentId}`.execute(this.db);
    if (!r.rows[0]) throw appError.notFound('Link not found.');
    return r.rows[0];
  }

  async overview(parentId: string, linkId: string) {
    await this.gate.require('feature.chhupa_rakshak');
    await this.sweep();
    const link = await this.parentLink(parentId, linkId);
    const consent = await sql<{ enabled: boolean; consented_at: Date; media_type: string }>`
      SELECT enabled, consented_at, media_type FROM monitoring_consents WHERE link_id = ${linkId}`.execute(this.db);
    const sessions = await sql<SessionRow>`
      SELECT * FROM monitoring_sessions WHERE link_id = ${linkId} ORDER BY started_at DESC LIMIT 30`.execute(this.db);
    const c = consent.rows[0];
    return {
      eligible: link.status === 'active',
      notEligibleReason: link.status === 'active' ? null : 'Your child must accept the family link first.',
      enabled: c?.enabled === true,
      consentVersion: MONITORING_CONSENT_VERSION,
      mediaType: c?.media_type ?? 'location',
      notice: MONITORING_NOTICE,
      expiryMinutes: await this.settings.get('monitor.expiry_minutes'),
      active: sessions.rows.find((s) => s.status === 'active') ? out(sessions.rows.find((s) => s.status === 'active')!) : null,
      history: sessions.rows.map(out),
    };
  }

  async setConsent(parentId: string, linkId: string, input: z.infer<typeof consentBody>) {
    await this.gate.require('feature.chhupa_rakshak');
    const link = await this.parentLink(parentId, linkId);
    if (input.enabled) {
      if (link.status !== 'active') throw appError.conflict('Your child must accept the family link first.');
      if (!input.accept) throw appError.invalidInput('Please read and accept the notice first.');
      await sql`
        INSERT INTO monitoring_consents (link_id, enabled, consent_version, consented_by)
        VALUES (${linkId}, true, ${MONITORING_CONSENT_VERSION}, ${parentId})
        ON CONFLICT (link_id) DO UPDATE
          SET enabled = true, consent_version = EXCLUDED.consent_version,
              consented_by = EXCLUDED.consented_by, consented_at = now(), updated_at = now()`.execute(this.db);
    } else {
      await sql`UPDATE monitoring_consents SET enabled = false, updated_at = now() WHERE link_id = ${linkId}`.execute(this.db);
      await sql`
        UPDATE monitoring_sessions SET status = 'stopped', end_reason = 'parent_stop', ended_at = now()
         WHERE link_id = ${linkId} AND status = 'active'`.execute(this.db);
    }
    return this.overview(parentId, linkId);
  }

  async start(parentId: string, linkId: string, input: z.infer<typeof startBody>) {
    await this.gate.require('feature.chhupa_rakshak');
    await this.sweep();
    const link = await this.parentLink(parentId, linkId);
    const same = await sql<SessionRow>`SELECT * FROM monitoring_sessions WHERE id = ${input.id}`.execute(this.db);
    if (same.rows[0]) return out(same.rows[0]);
    if (link.status !== 'active' || !link.child_user_id) {
      throw appError.conflict('This child is not linked right now.');
    }
    const consent = await sql<{ enabled: boolean }>`
      SELECT enabled FROM monitoring_consents WHERE link_id = ${linkId}`.execute(this.db);
    if (consent.rows[0]?.enabled !== true) {
      throw appError.conflict('Turn Chhupa Rakshak on for this child first.');
    }
    const minutes = await this.settings.get('monitor.expiry_minutes');
    const open = await sql`SELECT 1 FROM monitoring_sessions WHERE link_id = ${linkId} AND status = 'active'`.execute(this.db);
    if (open.rows.length > 0) throw appError.conflict('A session is already running for this child.');
    // The unique index allows one active session per child, even for two quick taps.
    const row = await sql<SessionRow>`
      INSERT INTO monitoring_sessions (id, link_id, started_by, reason, expires_at)
      VALUES (${input.id}, ${linkId}, ${parentId}, ${input.reason}, now() + make_interval(mins => ${minutes}))
      ON CONFLICT DO NOTHING
      RETURNING *`.execute(this.db);
    if (!row.rows[0]) throw appError.conflict('A session is already running for this child.');
    await sql`INSERT INTO monitoring_access_log (session_id, user_id, action) VALUES (${input.id}, ${parentId}, 'start')`.execute(this.db);
    await this.messages.notifyUser(
      link.child_user_id,
      'monitoring_session',
      'Chhupa Rakshak is on',
      'Your parent started a short location check. You can stop it in the app.',
      { sessionId: input.id },
    );
    return out(row.rows[0]);
  }

  async stopByParent(parentId: string, sessionId: string) {
    await this.gate.require('feature.chhupa_rakshak');
    const s = await sql<SessionRow>`
      SELECT s.* FROM monitoring_sessions s JOIN child_links l ON l.id = s.link_id
       WHERE s.id = ${sessionId} AND l.parent_user_id = ${parentId}`.execute(this.db);
    if (!s.rows[0]) throw appError.notFound('Session not found.');
    await sql`UPDATE monitoring_sessions SET status = 'stopped', end_reason = 'parent_stop', ended_at = now()
               WHERE id = ${sessionId} AND status = 'active'`.execute(this.db);
    await sql`INSERT INTO monitoring_access_log (session_id, user_id, action) VALUES (${sessionId}, ${parentId}, 'stop')`.execute(this.db);
    return this.sessionForParent(parentId, sessionId);
  }

  /** The parent's live view of one session. Each view is written to the access log. */
  async sessionForParent(parentId: string, sessionId: string) {
    await this.gate.require('feature.chhupa_rakshak');
    await this.sweep();
    const s = await sql<SessionRow>`
      SELECT s.* FROM monitoring_sessions s JOIN child_links l ON l.id = s.link_id
       WHERE s.id = ${sessionId} AND l.parent_user_id = ${parentId} AND l.status = 'active'`.execute(this.db);
    if (!s.rows[0]) throw appError.notFound('Session not found.');
    await sql`INSERT INTO monitoring_access_log (session_id, user_id, action) VALUES (${sessionId}, ${parentId}, 'view')`.execute(this.db);
    const last = await sql<{ lat: number; lng: number; accuracy_m: number | null; recorded_at: Date }>`
      SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng, accuracy_m, recorded_at
        FROM monitoring_samples WHERE session_id = ${sessionId} ORDER BY recorded_at DESC LIMIT 1`.execute(this.db);
    const staleMin = await this.settings.get('child.stale_gps_minutes');
    const l = last.rows[0];
    const maxAcc = await this.settings.get('child.max_accuracy_m');
    return {
      ...out(s.rows[0]),
      lastLocation: l
        ? {
            lat: l.lat,
            lng: l.lng,
            accuracyM: l.accuracy_m,
            recordedAt: l.recorded_at.toISOString(),
            stale: (Date.now() - l.recorded_at.getTime()) / 60_000 > staleMin,
            approximate: l.accuracy_m !== null && l.accuracy_m > maxAcc,
          }
        : null,
    };
  }

  // -- Child side: always visible ----------------------------------------------------------

  async forChild(childId: string) {
    await this.gate.require('feature.chhupa_rakshak');
    await this.sweep();
    const r = await sql<SessionRow & { parent_name: string | null }>`
      SELECT s.*, p.name AS parent_name
        FROM monitoring_sessions s
        JOIN child_links l ON l.id = s.link_id
        JOIN users p ON p.id = l.parent_user_id
       WHERE l.child_user_id = ${childId}
       ORDER BY s.started_at DESC LIMIT 30`.execute(this.db);
    const active = r.rows.find((s) => s.status === 'active');
    return {
      active: active ? { ...out(active), parentName: active.parent_name ?? 'Your parent' } : null,
      history: r.rows.map((s) => ({ ...out(s), parentName: s.parent_name ?? 'Your parent' })),
    };
  }

  private async childSession(childId: string, sessionId: string) {
    const r = await sql<SessionRow>`
      SELECT s.* FROM monitoring_sessions s JOIN child_links l ON l.id = s.link_id
       WHERE s.id = ${sessionId} AND l.child_user_id = ${childId} AND l.status = 'active'`.execute(this.db);
    if (!r.rows[0]) throw appError.notFound('Session not found.');
    return r.rows[0];
  }

  async sample(childId: string, sessionId: string, input: z.infer<typeof sampleBody>) {
    await this.gate.require('feature.chhupa_rakshak');
    await this.sweep();
    const s = await this.childSession(childId, sessionId);
    if (s.status !== 'active') throw appError.conflict('This session has ended.');
    await sql`
      INSERT INTO monitoring_samples (session_id, location, accuracy_m, recorded_at)
      VALUES (${sessionId}, ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326)::geography,
              ${input.accuracyM ?? null}, now())`.execute(this.db);
    return { ok: true };
  }

  async stopByChild(childId: string, sessionId: string) {
    await this.gate.require('feature.chhupa_rakshak');
    await this.childSession(childId, sessionId);
    await sql`UPDATE monitoring_sessions SET status = 'stopped', end_reason = 'child_stop', ended_at = now()
               WHERE id = ${sessionId} AND status = 'active'`.execute(this.db);
    return this.forChild(childId);
  }

  /** Metadata only for admins: never a location or any captured content. */
  async adminList() {
    const r = await sql<SessionRow & { child_name: string; views: string }>`
      SELECT s.*, l.child_name,
             (SELECT count(*) FROM monitoring_access_log a WHERE a.session_id = s.id AND a.action = 'view') AS views
        FROM monitoring_sessions s JOIN child_links l ON l.id = s.link_id
       ORDER BY s.started_at DESC LIMIT 200`.execute(this.db);
    return {
      items: r.rows.map((s) => ({
        id: s.id,
        status: s.status,
        endReason: s.end_reason,
        startedAt: s.started_at.toISOString(),
        endedAt: s.ended_at ? s.ended_at.toISOString() : null,
        minutes: Math.round(((s.ended_at ?? new Date()).getTime() - s.started_at.getTime()) / 60_000),
        views: Number(s.views),
      })),
    };
  }
}

@Controller('v1')
export class MonitoringController {
  constructor(
    private readonly service: MonitoringService,
    private readonly limiter: AppRateLimiter,
  ) {}

  @Get('monitoring/:linkId')
  overview(@Req() req: AppRequest, @Param('linkId', uuid) linkId: string) {
    return this.service.overview(req.user!.id, linkId);
  }

  @Put('monitoring/:linkId/consent')
  consent(@Req() req: AppRequest, @Param('linkId', uuid) linkId: string, @Body() body: unknown) {
    return this.service.setConsent(req.user!.id, linkId, parseAppBody(consentBody, body));
  }

  @Post('monitoring/:linkId/sessions')
  @HttpCode(200)
  async start(@Req() req: AppRequest, @Param('linkId', uuid) linkId: string, @Body() body: unknown) {
    await this.limiter.check(`monitor-start:${req.user!.id}`, 10, 3600);
    return this.service.start(req.user!.id, linkId, parseAppBody(startBody, body));
  }

  @Get('monitoring-sessions/:id')
  session(@Req() req: AppRequest, @Param('id', uuid) id: string) {
    return this.service.sessionForParent(req.user!.id, id);
  }

  @Post('monitoring-sessions/:id/stop')
  @HttpCode(200)
  stop(@Req() req: AppRequest, @Param('id', uuid) id: string) {
    return this.service.stopByParent(req.user!.id, id);
  }

  @Get('child/monitoring')
  forChild(@Req() req: AppRequest) {
    return this.service.forChild(req.user!.id);
  }

  @Post('child/monitoring/:id/location')
  @HttpCode(200)
  async sample(@Req() req: AppRequest, @Param('id', uuid) id: string, @Body() body: unknown) {
    await this.limiter.check(`monitor-sample:${req.user!.id}`, 400, 3600);
    return this.service.sample(req.user!.id, id, parseAppBody(sampleBody, body));
  }

  @Post('child/monitoring/:id/stop')
  @HttpCode(200)
  childStop(@Req() req: AppRequest, @Param('id', uuid) id: string) {
    return this.service.stopByChild(req.user!.id, id);
  }
}
