import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { CancelledSosRequest, Sos, StartSosRequest, TestSosRequest } from '@sarthi/shared';
import { sql, type Transaction } from 'kysely';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env.schema';
import { DatabaseService } from '../../database/database.module';
import type { Database } from '../../database/types';
import { appError } from '../common/app-http';
import { AppSettings } from '../common/app-settings';
import { AppRateLimiter } from '../common/rate-limit';
import { hashLinkCode, newGuardianLink } from '../common/guardian-links';
import { JobQueue } from '../jobs/job-queue';
import { LiveEvents } from '../live/live-events';
import { OutgoingMessages } from '../messages/outgoing-messages';

/** A phone clock may be a little ahead; more than this in the future is refused. */
const MAX_CLOCK_AHEAD_MS = 60_000;
/** An SOS saved offline may arrive late, but not older than this. */
const MAX_AGE_MS = 24 * 3600_000;

/** Test SOS per user per day. */
export const TEST_SOS_PER_DAY = 5;

interface NewLink {
  linkId: string;
  guardianId: string;
  phone: string;
  code: string;
  tokenHash: string;
}

@Injectable()
export class SosService {
  constructor(
    private readonly database: DatabaseService,
    private readonly settings: AppSettings,
    private readonly messages: OutgoingMessages,
    private readonly rateLimiter: AppRateLimiter,
    private readonly jobs: JobQueue,
    private readonly live: LiveEvents,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Starts a real SOS. The same id again returns the same SOS; while one is active, a new start
   * returns the active one.
   */
  async start(userId: string, input: StartSosRequest): Promise<Sos> {
    const startedAt = checkTime(input.startedAt, 'startedAt');
    const rules = await this.settings.snapshot();

    const created = await this.database.db.transaction().execute(async (trx) => {
      // One start at a time per user, so two quick presses can't make two active SOS.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${'sos:' + userId}))`.execute(trx);

      const same = await trx
        .selectFrom('sos_events')
        .select(['id', 'user_id'])
        .where('id', '=', input.id)
        .executeTakeFirst();
      if (same) {
        if (same.user_id !== userId) throw appError.conflict('This SOS id is already used.');
        return null;
      }
      const active = await this.activeId(userId, trx);
      if (active) return { id: active, links: [] as NewLink[], existing: true };

      if (input.journeyId) await this.checkJourney(userId, input.journeyId, trx);

      await trx
        .insertInto('sos_events')
        .values({
          id: input.id,
          user_id: userId,
          journey_id: input.journeyId ?? null,
          trigger: input.trigger,
          started_at: startedAt,
          rules,
        })
        .execute();

      if (input.location) {
        await trx
          .insertInto('location_points')
          .values({
            user_id: userId,
            sos_event_id: input.id,
            location: sql<string>`ST_SetSRID(ST_MakePoint(${input.location.lng}, ${input.location.lat}), 4326)::geography`,
            accuracy_m: input.location.accuracyM ?? null,
            recorded_at: startedAt,
          })
          .execute();
      }

      // A real SOS reaches guardians who accepted or have not answered yet; never declined ones.
      const guardians = await trx
        .selectFrom('guardians')
        .select(['id', 'phone'])
        .where('user_id', '=', userId)
        .where('invite_status', 'in', ['accepted', 'pending'])
        .where('phone', 'is not', null)
        .orderBy('created_at')
        .execute();
      const links: NewLink[] = guardians.map((g) => {
        const link = newGuardianLink(this.env);
        return {
          linkId: link.id,
          guardianId: g.id,
          phone: g.phone!,
          code: link.code,
          tokenHash: link.tokenHash,
        };
      });
      if (links.length > 0) {
        await trx
          .insertInto('guardian_links')
          .values(
            links.map((l) => ({
              id: l.linkId,
              guardian_id: l.guardianId,
              sos_event_id: input.id,
              token_hash: l.tokenHash,
              // Open while the SOS is active; set to a real time when it ends.
              expires_at: 'infinity',
            })),
          )
          .execute();
      }
      return { id: input.id, links, existing: false };
    });

    if (created && !created.existing) {
      await this.alertGuardians(userId, input.id, created.links, new Set(input.simSmsSentTo ?? []));
      // "No guardian responded": checked once after the copied number of minutes.
      await this.jobs
        .add(
          'sos-no-response',
          { sosId: input.id },
          {
            delayMs: rules['sos.no_response_minutes'] * 60_000,
            jobId: `no-response-${input.id}`,
          },
        )
        .catch(() => undefined); // the lost-contact sweep also catches missed timers
    }
    return this.get(userId, created?.id ?? input.id);
  }

  /** "I'm safe": ends the SOS; guardian links stay open a little longer, then expire. */
  async end(userId: string, sosId: string): Promise<Sos> {
    const sos = await this.database.db
      .selectFrom('sos_events')
      .select(['status', 'is_test', 'rules'])
      .where('id', '=', sosId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!sos) throw appError.notFound('SOS not found.');
    if (sos.status !== 'active') return this.get(userId, sosId);

    const minutes = sos.rules?.['guardian.link_live_after_end_minutes'] ?? 15;
    const ended = await this.database.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('sos_events')
        .set({
          status: 'ended',
          ended_at: sql<Date>`now()`,
          end_reason: 'safe',
          guardian_link_expires_at: sql<Date>`now() + make_interval(mins => ${minutes})`,
        })
        .where('id', '=', sosId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (updated.numUpdatedRows === 0n) return false;
      await trx
        .updateTable('guardian_links')
        .set({ expires_at: sql<Date>`now() + make_interval(mins => ${minutes})` })
        .where('sos_event_id', '=', sosId)
        .execute();
      return true;
    });

    if (ended) {
      await this.live.changed('sos', sosId);
      await this.tellGuardiansSafe(userId, sosId, sos.is_test);
    }
    return this.get(userId, sosId);
  }

  /**
   * A practice alert (marked TEST) to accepted guardians only, at most 5 a day. It is saved as an
   * SOS that has already ended: nothing to stop, no live link.
   */
  async test(userId: string, input: TestSosRequest): Promise<Sos> {
    const startedAt = checkTime(input.startedAt, 'startedAt');
    const same = await this.database.db
      .selectFrom('sos_events')
      .select(['user_id', 'is_test'])
      .where('id', '=', input.id)
      .executeTakeFirst();
    if (same) {
      if (same.user_id !== userId || !same.is_test) {
        throw appError.conflict('This SOS id is already used.');
      }
      return this.get(userId, input.id);
    }

    const guardians = await this.database.db
      .selectFrom('guardians')
      .select(['id', 'phone'])
      .where('user_id', '=', userId)
      .where('invite_status', '=', 'accepted')
      .where('phone', 'is not', null)
      .orderBy('created_at')
      .execute();
    if (guardians.length === 0) {
      throw appError.conflict('None of your guardians has accepted the invite yet.');
    }
    await this.rateLimiter.check(`test-sos:${userId}`, TEST_SOS_PER_DAY, 24 * 3600);

    const rules = await this.settings.snapshot();
    const inserted = await this.database.db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('sos_events')
        .values({
          id: input.id,
          user_id: userId,
          trigger: 'button',
          is_test: true,
          status: 'ended',
          started_at: startedAt,
          ended_at: sql<Date>`now()`,
          end_reason: 'test',
          rules,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!row) return false;
      // One row per guardian so the app can show each guardian's delivery; the link is never
      // sent and is closed from the start.
      await trx
        .insertInto('guardian_links')
        .values(
          guardians.map((g) => ({
            guardian_id: g.id,
            sos_event_id: input.id,
            token_hash: hashLinkCode(randomBytes(24).toString('base64url')),
            expires_at: sql<Date>`now()`,
          })),
        )
        .execute();
      return true;
    });

    if (inserted) {
      const name = await this.userName(userId);
      const text = `TEST from ${name} on Sarthi Rakshak. This is only a practice, no action needed.`;
      for (const g of guardians) {
        await this.messages.sendSms(g.phone!, {
          guardianId: g.id,
          kind: 'test',
          text,
          sosId: input.id,
        });
      }
    }
    return this.get(userId, input.id);
  }

  /** An SOS cancelled during the countdown: saved for reports only, nobody is alerted. */
  async reportCancelled(userId: string, input: CancelledSosRequest): Promise<void> {
    const startedAt = checkTime(input.startedAt, 'startedAt');
    const cancelledAt = checkTime(input.cancelledAt, 'cancelledAt');
    if (cancelledAt < startedAt) {
      throw appError.invalidInput('cancelledAt: Must not be before startedAt.');
    }
    const rules = await this.settings.snapshot();
    const inserted = await this.database.db
      .insertInto('sos_events')
      .values({
        id: input.id,
        user_id: userId,
        trigger: input.trigger,
        status: 'cancelled',
        started_at: startedAt,
        ended_at: cancelledAt,
        end_reason: 'cancelled_in_countdown',
        rules,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!inserted) {
      const existing = await this.database.db
        .selectFrom('sos_events')
        .select(['user_id', 'status'])
        .where('id', '=', input.id)
        .executeTakeFirstOrThrow();
      if (existing.user_id !== userId || existing.status !== 'cancelled') {
        throw appError.conflict('This SOS id is already used.');
      }
    }
  }

  async active(userId: string): Promise<Sos | null> {
    const id = await this.activeId(userId);
    return id ? this.get(userId, id) : null;
  }

  async get(userId: string, sosId: string): Promise<Sos> {
    const sos = await this.database.db
      .selectFrom('sos_events')
      .select(['id', 'trigger', 'is_test', 'status', 'started_at', 'ended_at'])
      .where('id', '=', sosId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!sos) throw appError.notFound('SOS not found.');

    const guardians = await this.database.db
      .selectFrom('guardian_links as l')
      .innerJoin('guardians as g', 'g.id', 'l.guardian_id')
      .select(['g.id', 'g.name', 'g.relation', 'l.opened_at', 'l.responding_at'])
      // Alerted = the first SOS message that reached this guardian (provider SMS or the
      // phone's own SIM SMS).
      .select((eb) =>
        eb
          .selectFrom('alerts as a')
          .select((a) => a.fn.min(sql<Date>`coalesce(a.sent_at, a.created_at)`).as('t'))
          .whereRef('a.guardian_id', '=', 'g.id')
          .where('a.sos_event_id', '=', sosId)
          .where('a.type', 'in', ['sos', 'sos_link'])
          .where('a.status', 'in', ['sent', 'delivered'])
          .as('alerted_at'),
      )
      .where('l.sos_event_id', '=', sosId)
      .orderBy('g.created_at')
      .execute();

    return {
      id: sos.id,
      trigger: sos.trigger,
      isTest: sos.is_test,
      status: sos.status,
      startedAt: new Date(sos.started_at).toISOString(),
      endedAt: sos.ended_at?.toISOString() ?? null,
      guardians: guardians.map((g) => ({
        guardianId: g.id,
        name: g.name,
        relation: g.relation,
        alertedAt: g.alerted_at ? new Date(g.alerted_at).toISOString() : null,
        openedAt: g.opened_at?.toISOString() ?? null,
        respondingAt: g.responding_at?.toISOString() ?? null,
      })),
    };
  }

  private async activeId(
    userId: string,
    db: Transaction<Database> | DatabaseService['db'] = this.database.db,
  ): Promise<string | null> {
    const row = await db
      .selectFrom('sos_events')
      .select('id')
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    return row?.id ?? null;
  }

  private async checkJourney(
    userId: string,
    journeyId: string,
    trx: Transaction<Database>,
  ): Promise<void> {
    const journey = await trx
      .selectFrom('journeys')
      .select('id')
      .where('id', '=', journeyId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!journey) throw appError.invalidInput('journeyId: Not one of your journeys.');
  }

  private async userName(userId: string): Promise<string> {
    const user = await this.database.db
      .selectFrom('users')
      .select('name')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    return user.name?.trim() || 'Someone who added you as a guardian';
  }

  /**
   * One SMS per guardian with their own live link. Guardians the phone already reached by SIM SMS
   * get only the live link, never a second SOS SMS.
   */
  private async alertGuardians(
    userId: string,
    sosId: string,
    links: NewLink[],
    simSmsSentTo: Set<string>,
  ): Promise<void> {
    const name = await this.userName(userId);
    for (const link of links) {
      const url = `${this.env.GUARDIAN_WEB_URL}/l/${link.code}`;
      if (simSmsSentTo.has(link.guardianId)) {
        // The phone already sent the SOS SMS from its SIM: record it for the admin's alert log.
        await this.database.db
          .insertInto('alerts')
          .values({
            guardian_id: link.guardianId,
            sos_event_id: sosId,
            channel: 'sim_sms',
            type: 'sos',
            status: 'sent',
            sent_at: sql<Date>`now()`,
          })
          .execute();
        const text = `${name}'s SOS live location on Sarthi Rakshak: ${url}`;
        await this.messages.sendSms(link.phone, {
          guardianId: link.guardianId,
          kind: 'sos_link',
          text,
          sosId,
        });
      } else {
        const text = `SOS from ${name} on Sarthi Rakshak. See their live location: ${url} If you can't reach them, call 112.`;
        await this.messages.sendSms(link.phone, {
          guardianId: link.guardianId,
          kind: 'sos',
          text,
          sosId,
        });
      }
    }
  }

  private async tellGuardiansSafe(userId: string, sosId: string, isTest: boolean): Promise<void> {
    const name = await this.userName(userId);
    const guardians = await this.database.db
      .selectFrom('guardian_links as l')
      .innerJoin('guardians as g', 'g.id', 'l.guardian_id')
      .select(['g.id', 'g.phone'])
      .where('l.sos_event_id', '=', sosId)
      .where('g.phone', 'is not', null)
      .execute();
    const text = `${isTest ? 'TEST: ' : ''}${name} is safe and has ended the SOS on Sarthi Rakshak.`;
    for (const g of guardians) {
      await this.messages.sendSms(g.phone!, { guardianId: g.id, kind: 'safe', text, sosId });
    }
  }
}

/** A phone time: not more than a minute ahead, not older than a day. */
function checkTime(value: string, field: string): Date {
  const time = new Date(value);
  const now = Date.now();
  if (time.getTime() > now + MAX_CLOCK_AHEAD_MS) {
    throw appError.invalidInput(`${field}: Is in the future. Check the phone's clock.`);
  }
  if (time.getTime() < now - MAX_AGE_MS) {
    throw appError.invalidInput(`${field}: Is more than a day old.`);
  }
  return time;
}
