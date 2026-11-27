import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.module';
import { appError, parseAppBody, type AppRequest } from '../common/app-http';
import { AppSettings } from '../common/app-settings';
import { AppRateLimiter } from '../common/rate-limit';
import { OutgoingMessages } from '../messages/outgoing-messages';
import { Phase4Gate } from '../phase4/common';

const uuid = new ParseUUIDPipe({ exceptionFactory: () => appError.notFound('Not found.') });
const MAX_SKEW_MS = 5 * 60_000;

export const KINDS = ['arrived', 'present', 'departed', 'authorised_absence', 'correction'] as const;

const eventBody = z.object({
  idempotencyKey: z.string().trim().min(6).max(80),
  kind: z.enum(KINDS),
  studentRef: z.string().trim().min(1).max(60),
  occurredAt: z.iso.datetime({ offset: true }),
  correctsKey: z.string().trim().min(6).max(80).optional(),
  reason: z.string().trim().min(3).max(200).optional(),
});

const linkBody = z.object({
  id: z.uuid(),
  schoolId: z.uuid(),
  childName: z.string().trim().min(1).max(60),
  studentRef: z.string().trim().min(1).max(60),
});

/** The text a school signs: HMAC-SHA256 (hex) over this string with its secret. */
export function schoolSigningString(ts: string, e: Pick<z.infer<typeof eventBody>, 'idempotencyKey' | 'kind' | 'studentRef' | 'occurredAt'>): string {
  return [ts, e.idempotencyKey, e.kind, e.studentRef, e.occurredAt].join('.');
}

export function signSchoolEvent(secret: string, signing: string): string {
  return createHmac('sha256', secret).update(signing).digest('hex');
}

export function newSchoolSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

const LABEL: Record<string, string> = {
  arrived: 'Arrived at school',
  present: 'Marked present',
  departed: 'Left school',
  authorised_absence: 'Authorised absence',
  correction: 'Correction',
};

@Injectable()
export class SchoolService {
  constructor(
    private readonly database: DatabaseService,
    private readonly settings: AppSettings,
    private readonly gate: Phase4Gate,
    private readonly messages: OutgoingMessages,
  ) {}

  private get db() {
    return this.database.db;
  }

  // -- Parent side ---------------------------------------------------------------------------

  async directory(q: string | undefined) {
    await this.gate.require('feature.school');
    const term = `%${(q ?? '').trim().replace(/[%_]/g, '')}%`;
    const r = await sql<{ id: string; name: string; city: string | null; code: string }>`
      SELECT id, name, city, code FROM schools
       WHERE status = 'verified' AND (name ILIKE ${term} OR city ILIKE ${term})
       ORDER BY name LIMIT 30`.execute(this.db);
    return { items: r.rows.map((s) => ({ id: s.id, name: s.name, city: s.city, code: s.code })) };
  }

  async createLink(parentId: string, input: z.infer<typeof linkBody>) {
    await this.gate.require('feature.school');
    const school = await sql`SELECT 1 FROM schools WHERE id = ${input.schoolId} AND status = 'verified'`.execute(this.db);
    if (school.rows.length === 0) throw appError.notFound('This school is not in the approved list.');
    const same = await sql<{ parent_user_id: string }>`SELECT parent_user_id FROM school_links WHERE id = ${input.id}`.execute(this.db);
    if (same.rows[0]) {
      if (same.rows[0].parent_user_id !== parentId) throw appError.conflict('This id is already used.');
      return this.links(parentId).then((l) => l.items.find((x) => x.id === input.id));
    }
    const count = await sql<{ n: string }>`SELECT count(*) AS n FROM school_links WHERE parent_user_id = ${parentId} AND status NOT IN ('rejected','revoked')`.execute(this.db);
    if (Number(count.rows[0].n) >= 5) throw appError.conflict('You can link up to 5 children.');
    try {
      await sql`INSERT INTO school_links (id, parent_user_id, school_id, child_name, student_ref)
                VALUES (${input.id}, ${parentId}, ${input.schoolId}, ${input.childName}, ${input.studentRef})`.execute(this.db);
    } catch {
      throw appError.conflict('You already asked to link this child at this school.');
    }
    return this.links(parentId).then((l) => l.items.find((x) => x.id === input.id));
  }

  async links(parentId: string) {
    await this.gate.require('feature.school');
    const stale = await this.settings.get('school.stale_feed_hours');
    const r = await sql<{
      id: string; child_name: string; status: string; note: string | null; created_at: Date;
      school_name: string; last_event_at: Date | null;
    }>`
      SELECT l.id, l.child_name, l.status, l.note, l.created_at, s.name AS school_name, s.last_event_at
        FROM school_links l JOIN schools s ON s.id = l.school_id
       WHERE l.parent_user_id = ${parentId} ORDER BY l.created_at`.execute(this.db);
    return {
      items: r.rows.map((l) => ({
        id: l.id,
        childName: l.child_name,
        status: l.status,
        note: l.status === 'rejected' || l.status === 'suspended' ? l.note : null,
        schoolName: l.school_name,
        lastSchoolEventAt: l.last_event_at ? l.last_event_at.toISOString() : null,
        // A school that has gone quiet is flagged. Silence is never shown as "absent".
        staleFeed:
          l.status === 'active' &&
          (!l.last_event_at || Date.now() - l.last_event_at.getTime() > stale * 3_600_000),
      })),
    };
  }

  async revoke(parentId: string, id: string) {
    await this.gate.require('feature.school');
    const r = await sql`UPDATE school_links SET status = 'revoked', updated_at = now()
                         WHERE id = ${id} AND parent_user_id = ${parentId} RETURNING id`.execute(this.db);
    if (r.rows.length === 0) throw appError.notFound('Link not found.');
    return this.links(parentId);
  }

  async events(parentId: string, linkId: string) {
    await this.gate.require('feature.school');
    const link = await sql<{ school_id: string; student_ref: string; status: string }>`
      SELECT school_id, student_ref, status FROM school_links WHERE id = ${linkId} AND parent_user_id = ${parentId}`.execute(this.db);
    if (!link.rows[0]) throw appError.notFound('Link not found.');
    if (link.rows[0].status !== 'active') return { items: [], note: 'Events appear once the school confirms the link.' };
    const r = await sql<{
      kind: string; occurred_at: Date; received_at: Date; corrects_key: string | null; reason: string | null;
    }>`
      SELECT kind, occurred_at, received_at, corrects_key, reason FROM school_events
       WHERE school_id = ${link.rows[0].school_id} AND student_ref = ${link.rows[0].student_ref}
       ORDER BY occurred_at DESC, id DESC LIMIT 200`.execute(this.db);
    return {
      note: null,
      items: r.rows.map((e) => ({
        kind: e.kind,
        label: LABEL[e.kind],
        source: 'school', // never mixed up with phone GPS events
        occurredAt: e.occurred_at.toISOString(),
        syncedAt: e.received_at.toISOString(),
        correction: e.kind === 'correction',
        reason: e.reason,
      })),
    };
  }

  // -- Signed events from a school ---------------------------------------------------------------

  private async quarantine(schoolId: string | null, type: string, detail: string, raw: unknown) {
    await sql`INSERT INTO school_quarantine (school_id, error_type, detail, raw)
              VALUES (${schoolId}, ${type}, ${detail}, ${JSON.stringify(raw).slice(0, 2000)})`.execute(this.db);
  }

  async receive(code: string, ts: string | undefined, signature: string | undefined, body: unknown) {
    await this.gate.require('feature.school');
    const s = await sql<{ id: string; status: string; secret: string }>`
      SELECT id, status, secret FROM schools WHERE code = ${code.toUpperCase()}`.execute(this.db);
    const school = s.rows[0];
    if (!school) throw appError.notFound('Unknown school.');
    if (school.status !== 'verified') {
      await this.quarantine(school.id, 'unverified_school', 'School is not verified', body);
      throw appError.invalidInput('This school is not verified to send events.');
    }
    const parsed = eventBody.safeParse(body);
    if (!parsed.success) {
      await this.quarantine(school.id, 'invalid_format', parsed.error.issues[0]?.message ?? 'Bad format', body);
      throw appError.invalidInput('The event is not in the agreed format.');
    }
    const e = parsed.data;
    const skew = Math.abs(Date.now() - Number(ts));
    if (!ts || !Number.isFinite(skew) || skew > MAX_SKEW_MS) {
      await this.quarantine(school.id, 'stale_timestamp', 'Timestamp missing or too old', e);
      throw appError.invalidInput('The timestamp is missing or too old.');
    }
    const expected = signSchoolEvent(school.secret, schoolSigningString(ts, e));
    if (!signature || !safeEqualHex(signature, expected)) {
      await this.quarantine(school.id, 'bad_signature', 'Signature did not match', e);
      throw appError.invalidInput('The signature is not valid.');
    }
    if (e.kind === 'correction' && (!e.correctsKey || !e.reason)) {
      await this.quarantine(school.id, 'invalid_correction', 'A correction needs correctsKey and reason', e);
      throw appError.invalidInput('A correction needs the original key and a reason.');
    }
    const parents = await sql<{ parent_user_id: string; child_name: string }>`
      SELECT parent_user_id, child_name FROM school_links
       WHERE school_id = ${school.id} AND student_ref = ${e.studentRef} AND status = 'active'`.execute(this.db);
    if (parents.rows.length === 0) {
      await this.quarantine(school.id, 'unmapped_child', 'No linked child for this student reference', e);
      throw appError.invalidInput('No linked child matches this student reference.');
    }
    const ins = await sql`
      INSERT INTO school_events (school_id, student_ref, idempotency_key, kind, occurred_at, corrects_key, reason)
      VALUES (${school.id}, ${e.studentRef}, ${e.idempotencyKey}, ${e.kind}, ${e.occurredAt}, ${e.correctsKey ?? null}, ${e.reason ?? null})
      ON CONFLICT (school_id, idempotency_key) DO NOTHING RETURNING id`.execute(this.db);
    await sql`UPDATE schools SET last_event_at = now() WHERE id = ${school.id}`.execute(this.db);
    if (ins.rows.length === 0) return { status: 'duplicate' };
    for (const p of parents.rows) {
      await this.messages.notifyUser(
        p.parent_user_id,
        'school_event',
        `${p.child_name}: ${LABEL[e.kind]}`,
        'Reported by the school. This is not from the phone’s GPS.',
        { kind: e.kind },
      );
    }
    return { status: 'accepted' };
  }

  // -- Admin ----------------------------------------------------------------------------------

  async adminSchools() {
    const r = await sql<{
      id: string; code: string; name: string; city: string | null; status: string; secret_version: number;
      last_event_at: Date | null; events: string; quarantined: string; links: string;
    }>`
      SELECT s.id, s.code, s.name, s.city, s.status, s.secret_version, s.last_event_at,
             (SELECT count(*) FROM school_events e WHERE e.school_id = s.id) AS events,
             (SELECT count(*) FROM school_quarantine q WHERE q.school_id = s.id) AS quarantined,
             (SELECT count(*) FROM school_links l WHERE l.school_id = s.id AND l.status = 'active') AS links
        FROM schools s ORDER BY s.name`.execute(this.db);
    const stale = await this.settings.get('school.stale_feed_hours');
    return {
      items: r.rows.map((s) => ({
        id: s.id, code: s.code, name: s.name, city: s.city, status: s.status,
        keyVersion: s.secret_version,
        lastEventAt: s.last_event_at ? s.last_event_at.toISOString() : null,
        staleFeed: s.status === 'verified' && (!s.last_event_at || Date.now() - s.last_event_at.getTime() > stale * 3_600_000),
        events: Number(s.events), rejected: Number(s.quarantined), activeLinks: Number(s.links),
      })),
    };
  }

  async createSchool(input: { code: string; name: string; city?: string | null }) {
    const secret = newSchoolSecret();
    try {
      const r = await sql<{ id: string }>`
        INSERT INTO schools (code, name, city, secret) VALUES (${input.code.toUpperCase()}, ${input.name}, ${input.city ?? null}, ${secret})
        RETURNING id`.execute(this.db);
      return { id: r.rows[0].id, secret }; // shown once
    } catch {
      throw appError.conflict('That school code is already used.');
    }
  }

  async setSchoolStatus(id: string, status: 'pending' | 'verified' | 'suspended') {
    const r = await sql`UPDATE schools SET status = ${status} WHERE id = ${id} RETURNING id`.execute(this.db);
    if (r.rows.length === 0) throw appError.notFound('School not found.');
    return { ok: true };
  }

  async rotateKey(id: string) {
    const secret = newSchoolSecret();
    const r = await sql`UPDATE schools SET secret = ${secret}, secret_version = secret_version + 1 WHERE id = ${id} RETURNING id`.execute(this.db);
    if (r.rows.length === 0) throw appError.notFound('School not found.');
    return { secret }; // shown once; the old key stops working at once
  }

  async adminLinks(status?: string) {
    const r = await sql<{
      id: string; child_name: string; student_ref: string; status: string; school_name: string; created_at: Date; note: string | null;
    }>`
      SELECT l.id, l.child_name, l.student_ref, l.status, l.note, l.created_at, s.name AS school_name
        FROM school_links l JOIN schools s ON s.id = l.school_id
       WHERE (${status ?? null}::text IS NULL OR l.status = ${status ?? null})
       ORDER BY l.created_at DESC LIMIT 200`.execute(this.db);
    return {
      items: r.rows.map((l) => ({
        id: l.id, childName: l.child_name, studentRef: l.student_ref, status: l.status,
        schoolName: l.school_name, note: l.note, createdAt: l.created_at.toISOString(),
      })),
    };
  }

  async decideLink(adminId: string, id: string, status: 'pending' | 'active' | 'rejected' | 'suspended', note?: string) {
    const r = await sql<{ parent_user_id: string; child_name: string }>`
      UPDATE school_links SET status = ${status}, note = ${note ?? null}, decided_by = ${adminId}, updated_at = now()
       WHERE id = ${id} RETURNING parent_user_id, child_name`.execute(this.db);
    if (!r.rows[0]) throw appError.notFound('Link not found.');
    await this.messages.notifyUser(r.rows[0].parent_user_id, 'school_event', 'School link update',
      `${r.rows[0].child_name}: ${status}`, { linkId: id });
    return { ok: true };
  }

  async quarantineList() {
    const r = await sql<{ id: string; school_name: string | null; error_type: string; detail: string | null; received_at: Date }>`
      SELECT q.id, s.name AS school_name, q.error_type, q.detail, q.received_at
        FROM school_quarantine q LEFT JOIN schools s ON s.id = q.school_id
       ORDER BY q.id DESC LIMIT 200`.execute(this.db);
    return { items: r.rows.map((q) => ({ id: q.id, school: q.school_name, errorType: q.error_type, detail: q.detail, receivedAt: q.received_at.toISOString() })) };
  }
}

@Controller()
export class SchoolController {
  constructor(
    private readonly service: SchoolService,
    private readonly limiter: AppRateLimiter,
  ) {}

  @Get('v1/schools')
  directory(@Query('q') q?: string) {
    return this.service.directory(q);
  }

  @Get('v1/school-links')
  links(@Req() req: AppRequest) {
    return this.service.links(req.user!.id);
  }

  @Post('v1/school-links')
  @HttpCode(200)
  async create(@Req() req: AppRequest, @Body() body: unknown) {
    await this.limiter.check(`school-link:${req.user!.id}`, 10, 3600);
    return this.service.createLink(req.user!.id, parseAppBody(linkBody, body));
  }

  @Post('v1/school-links/:id/revoke')
  @HttpCode(200)
  revoke(@Req() req: AppRequest, @Param('id', uuid) id: string) {
    return this.service.revoke(req.user!.id, id);
  }

  @Get('v1/school-links/:id/events')
  events(@Req() req: AppRequest, @Param('id', uuid) id: string) {
    return this.service.events(req.user!.id, id);
  }

  /** Signed events from a school. No login: the signature is the proof. */
  @Post('hooks/school/:code')
  @HttpCode(200)
  async hook(
    @Param('code') code: string,
    @Headers('x-sr-timestamp') ts: string | undefined,
    @Headers('x-sr-signature') signature: string | undefined,
    @Body() body: unknown,
  ) {
    await this.limiter.check(`school-hook:${code.toUpperCase()}`, 600, 60);
    return this.service.receive(code, ts, signature, body);
  }
}
