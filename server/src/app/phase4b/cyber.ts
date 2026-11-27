import { Body, Controller, Get, HttpCode, Injectable, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.module';
import { appError, parseAppBody, type AppRequest } from '../common/app-http';
import { AppRateLimiter } from '../common/rate-limit';
import { OutgoingMessages } from '../messages/outgoing-messages';
import { Phase4Gate } from '../phase4/common';
import { classify, isUncertain } from './cyber-classifier';

const uuid = new ParseUUIDPipe({ exceptionFactory: () => appError.notFound('Not found.') });

export const CYBER_NOTICE =
  'Only text that you paste or share into Sarthi Rakshak is checked. Nothing is read from WhatsApp, Instagram or any other account, ' +
  'and no passwords are ever asked for. Flags are risk signals for a person to review, not proof. ' +
  'Alerts go only to the linked parent and child. The other person is never contacted or accused.';

const sourceBody = z.object({ enabled: z.boolean(), accept: z.boolean().default(false) });
const analyseBody = z.object({ text: z.string().trim().min(3).max(5000) });
const reviewBody = z.object({
  status: z.enum(['reviewed', 'false_positive', 'dismissed']),
  note: z.string().trim().max(500).optional(),
});

interface FlagRow {
  id: string; category: string; confidence: string; uncertain: boolean; excerpt: string | null;
  explanation: string; status: string; note: string | null; created_at: Date;
}
const flagOut = (f: FlagRow) => ({
  id: f.id, category: f.category, confidence: f.confidence,
  label: f.uncertain ? 'Uncertain' : f.confidence === 'high' ? 'Likely' : 'Possible',
  excerpt: f.excerpt, explanation: f.explanation, status: f.status, note: f.note,
  createdAt: f.created_at.toISOString(),
  source: 'Text you shared',
});

@Injectable()
export class CyberService {
  constructor(
    private readonly database: DatabaseService,
    private readonly gate: Phase4Gate,
    private readonly messages: OutgoingMessages,
  ) {}

  private get db() {
    return this.database.db;
  }

  /** The caller must be the parent or the linked child of an active link. */
  private async member(userId: string, linkId: string) {
    const r = await sql<{ parent_user_id: string; child_user_id: string | null; status: string; child_name: string }>`
      SELECT parent_user_id, child_user_id, status, child_name FROM child_links WHERE id = ${linkId}`.execute(this.db);
    const l = r.rows[0];
    if (!l || (l.parent_user_id !== userId && l.child_user_id !== userId)) throw appError.notFound('Link not found.');
    return { ...l, isParent: l.parent_user_id === userId };
  }

  async overview(userId: string, linkId: string) {
    await this.gate.require('feature.cyber_safety');
    const l = await this.member(userId, linkId);
    const src = await sql<{ id: string; enabled: boolean }>`
      SELECT id, enabled FROM cyber_sources WHERE link_id = ${linkId} AND kind = 'shared_text'`.execute(this.db);
    const flags = await sql<FlagRow>`
      SELECT id::text, category, confidence, uncertain, excerpt, explanation, status, note, created_at
        FROM cyber_flags WHERE link_id = ${linkId} ORDER BY created_at DESC LIMIT 100`.execute(this.db);
    return {
      isParent: l.isParent,
      eligible: l.status === 'active',
      notice: CYBER_NOTICE,
      sources: [{ kind: 'shared_text', label: 'Text you paste or share', enabled: src.rows[0]?.enabled === true }],
      flags: flags.rows.map(flagOut),
    };
  }

  async setSource(userId: string, linkId: string, input: z.infer<typeof sourceBody>) {
    await this.gate.require('feature.cyber_safety');
    const l = await this.member(userId, linkId);
    if (!l.isParent) throw appError.notFound('Link not found.');
    if (input.enabled) {
      if (l.status !== 'active') throw appError.conflict('Your child must accept the family link first.');
      if (!input.accept) throw appError.invalidInput('Please read and accept the notice first.');
    }
    await sql`
      INSERT INTO cyber_sources (link_id, kind, enabled, consented_by)
      VALUES (${linkId}, 'shared_text', ${input.enabled}, ${userId})
      ON CONFLICT (link_id, kind) DO UPDATE SET enabled = EXCLUDED.enabled, consented_by = EXCLUDED.consented_by, consented_at = now()`.execute(this.db);
    return this.overview(userId, linkId);
  }

  async analyse(userId: string, linkId: string, text: string) {
    await this.gate.require('feature.cyber_safety');
    const l = await this.member(userId, linkId);
    if (l.status !== 'active') throw appError.conflict('The family link is not active.');
    const src = await sql<{ id: string; enabled: boolean }>`
      SELECT id, enabled FROM cyber_sources WHERE link_id = ${linkId} AND kind = 'shared_text'`.execute(this.db);
    if (!src.rows[0]?.enabled) throw appError.conflict('Your parent has not turned this on yet.');
    const found = classify(text);
    // Only the redacted excerpt is stored, never the full message.
    for (const f of found) {
      await sql`
        INSERT INTO cyber_flags (link_id, source_id, submitted_by, category, confidence, uncertain, excerpt, explanation)
        VALUES (${linkId}, ${src.rows[0].id}, ${userId}, ${f.category}, ${f.confidence}, ${isUncertain(f.confidence)}, ${f.excerpt}, ${f.explanation})`.execute(this.db);
    }
    if (found.length > 0) {
      for (const target of [l.parent_user_id, l.child_user_id]) {
        if (!target) continue;
        await this.messages.notifyUser(target, 'cyber_flag', 'Something may need a look',
          'A shared message was flagged as a possible risk. Open Sarthi Rakshak to review it.', { linkId });
      }
    }
    return { flagged: found.length, flags: found.map((f) => ({ category: f.category, confidence: f.confidence, uncertain: isUncertain(f.confidence), explanation: f.explanation })) };
  }

  async review(userId: string, flagId: string, input: z.infer<typeof reviewBody>) {
    await this.gate.require('feature.cyber_safety');
    const f = await sql<{ link_id: string }>`SELECT link_id FROM cyber_flags WHERE id = ${flagId}`.execute(this.db);
    if (!f.rows[0]) throw appError.notFound('Flag not found.');
    const l = await this.member(userId, f.rows[0].link_id);
    if (!l.isParent) throw appError.notFound('Flag not found.');
    await sql`UPDATE cyber_flags SET status = ${input.status}, note = ${input.note ?? null}, reviewed_at = now() WHERE id = ${flagId}`.execute(this.db);
    return this.overview(userId, f.rows[0].link_id);
  }

  /** Counts only for admins: no excerpts, no names. */
  async adminSummary() {
    const r = await sql<{ category: string; status: string; n: string }>`
      SELECT category, status, count(*) AS n FROM cyber_flags GROUP BY category, status ORDER BY category, status`.execute(this.db);
    const s = await sql<{ n: string }>`SELECT count(*) AS n FROM cyber_sources WHERE enabled`.execute(this.db);
    return { enabledSources: Number(s.rows[0].n), flags: r.rows.map((x) => ({ category: x.category, status: x.status, count: Number(x.n) })) };
  }
}

@Controller('v1/cyber')
export class CyberController {
  constructor(private readonly service: CyberService, private readonly limiter: AppRateLimiter) {}

  @Get(':linkId')
  overview(@Req() req: AppRequest, @Param('linkId', uuid) linkId: string) {
    return this.service.overview(req.user!.id, linkId);
  }

  @Put(':linkId/source')
  source(@Req() req: AppRequest, @Param('linkId', uuid) linkId: string, @Body() body: unknown) {
    return this.service.setSource(req.user!.id, linkId, parseAppBody(sourceBody, body));
  }

  @Post(':linkId/analyse')
  @HttpCode(200)
  async analyse(@Req() req: AppRequest, @Param('linkId', uuid) linkId: string, @Body() body: unknown) {
    await this.limiter.check(`cyber-analyse:${req.user!.id}`, 60, 3600);
    return this.service.analyse(req.user!.id, linkId, parseAppBody(analyseBody, body).text);
  }

  @Post('flags/:id/review')
  @HttpCode(200)
  review(@Req() req: AppRequest, @Param('id') id: string, @Body() body: unknown) {
    if (!/^[0-9]{1,18}$/.test(id)) throw appError.notFound('Flag not found.');
    return this.service.review(req.user!.id, id, parseAppBody(reviewBody, body));
  }
}
