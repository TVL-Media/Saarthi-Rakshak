import { Inject, Injectable } from '@nestjs/common';
import type {
  AnswerCheckinRequest,
  Checkin,
  EndJourneyRequest,
  Journey,
  RaiseCheckinRequest,
  StartJourneyRequest,
} from '@sarthi/shared';
import { sql, type Transaction } from 'kysely';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env.schema';
import { DatabaseService } from '../../database/database.module';
import type { Database } from '../../database/types';
import { appError } from '../common/app-http';
import { AppSettings } from '../common/app-settings';
import { newGuardianLink } from '../common/guardian-links';
import { JobQueue } from '../jobs/job-queue';
import { LiveEvents } from '../live/live-events';
import { OutgoingMessages } from '../messages/outgoing-messages';

/** Arrival time must be at least this far ahead… */
const MIN_AHEAD_MS = 5 * 60_000;
/** …and at most this far ahead. */
const MAX_AHEAD_MS = 12 * 3600_000;
/** A phone clock may be a little behind; a time this close to "now + 5 min" is still accepted. */
const CLOCK_SLACK_MS = 60_000;
/** After "I'm fine", the same reason is not asked again for this long. */
export const FINE_QUIET_MINUTES = 5;

/** "11:28 pm" in India time. */
const indiaTime = (d: Date) =>
  new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  }).format(d);

type CheckinRow = {
  id: string;
  reason: Checkin['reason'];
  source: Checkin['source'];
  status: Checkin['status'];
  asked_at: Date;
};

const toCheckin = (c: CheckinRow): Checkin => ({
  id: c.id,
  reason: c.reason,
  source: c.source,
  status: c.status,
  askedAt: c.asked_at.toISOString(),
});

@Injectable()
export class JourneysService {
  constructor(
    private readonly database: DatabaseService,
    private readonly settings: AppSettings,
    private readonly messages: OutgoingMessages,
    private readonly jobs: JobQueue,
    private readonly live: LiveEvents,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Starts a journey shared with all accepted guardians. The same id again returns it. */
  async start(userId: string, input: StartJourneyRequest): Promise<Journey> {
    const arrival = new Date(input.expectedArrivalAt);
    const ahead = arrival.getTime() - Date.now();
    if (ahead < MIN_AHEAD_MS - CLOCK_SLACK_MS || ahead > MAX_AHEAD_MS) {
      throw appError.invalidInput('expectedArrivalAt: Choose a time within the next 12 hours.');
    }
    const rules = await this.settings.snapshot();

    const created = await this.database.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${'journey:' + userId}))`.execute(trx);

      const same = await trx
        .selectFrom('journeys')
        .select('user_id')
        .where('id', '=', input.id)
        .executeTakeFirst();
      if (same) {
        if (same.user_id !== userId) throw appError.conflict('This journey id is already used.');
        return null;
      }
      const active = await trx
        .selectFrom('journeys')
        .select('id')
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (active) throw appError.conflict('You already have a journey on. End it first.');

      const guardians = await trx
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

      await trx
        .insertInto('journeys')
        .values({
          id: input.id,
          user_id: userId,
          destination: sql<string>`ST_SetSRID(ST_MakePoint(${input.destination.lng}, ${input.destination.lat}), 4326)::geography`,
          destination_label: input.destination.label,
          expected_arrival_at: arrival,
          route_polyline: input.route ?? null,
          rules,
        })
        .execute();

      const links = guardians.map((g) => ({
        guardianId: g.id,
        phone: g.phone!,
        ...newGuardianLink(this.env),
      }));
      await trx
        .insertInto('guardian_links')
        .values(
          links.map((l) => ({
            id: l.id,
            guardian_id: l.guardianId,
            journey_id: input.id,
            token_hash: l.tokenHash,
            // Open while the journey is on; set to a real time when it ends.
            expires_at: 'infinity',
          })),
        )
        .execute();
      return links;
    });

    if (created) {
      const name = await this.userName(userId);
      for (const link of created) {
        const url = `${this.env.GUARDIAN_WEB_URL}/l/${link.code}`;
        await this.messages.sendSms(link.phone, {
          guardianId: link.guardianId,
          kind: 'journey_started',
          journeyId: input.id,
          text: `${name} started a journey to ${input.destination.label}, arriving ${indiaTime(arrival)}. Follow: ${url}`,
        });
      }
    }
    return this.get(userId, input.id);
  }

  /** "I reached safely" (arrived) or "End journey" (ended). Ending twice is fine. */
  async end(userId: string, journeyId: string, input: EndJourneyRequest): Promise<Journey> {
    const journey = await this.own(userId, journeyId);
    if (journey.status !== 'active') return this.get(userId, journeyId);

    const minutes = journey.rules?.['guardian.link_live_after_end_minutes'] ?? 15;
    const ended = await this.database.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('journeys')
        .set({ status: input.outcome, ended_at: sql<Date>`now()` })
        .where('id', '=', journeyId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (updated.numUpdatedRows === 0n) return false;
      await trx
        .updateTable('guardian_links')
        .set({ expires_at: sql<Date>`now() + make_interval(mins => ${minutes})` })
        .where('journey_id', '=', journeyId)
        .execute();
      // A check-in still waiting is closed: the user is no longer travelling.
      await trx
        .updateTable('checkins')
        .set({ status: 'fine', answered_at: sql<Date>`now()` })
        .where('journey_id', '=', journeyId)
        .where('status', '=', 'pending')
        .execute();
      return true;
    });

    if (ended) {
      await this.live.changed('journey', journeyId);
      const name = await this.userName(userId);
      const place = journey.destination_label ?? 'their destination';
      const text =
        input.outcome === 'arrived'
          ? `${name} reached ${place} safely.`
          : `${name} ended the journey to ${place}.`;
      for (const g of await this.linkedGuardians(journeyId)) {
        await this.messages.sendSms(g.phone, {
          guardianId: g.id,
          kind: input.outcome === 'arrived' ? 'journey_arrived' : 'journey_ended',
          text,
          journeyId,
        });
      }
    }
    return this.get(userId, journeyId);
  }

  async active(userId: string): Promise<Journey | null> {
    const row = await this.database.db
      .selectFrom('journeys')
      .select('id')
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    return row ? this.get(userId, row.id) : null;
  }

  /**
   * The phone shows "Are you okay?" and tells the server. Refused while check-ins are paused
   * ("Stuck in traffic") or within 5 minutes of "I'm fine" for the same reason. While one is
   * waiting for an answer, that one is returned.
   */
  async raiseCheckin(
    userId: string,
    journeyId: string,
    input: RaiseCheckinRequest,
  ): Promise<Checkin> {
    let replyWaitMinutes = null as number | null;
    const checkin = await this.database.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${'checkin:' + journeyId}))`.execute(trx);
      const journey = await this.own(userId, journeyId, trx);

      const same = await trx
        .selectFrom('checkins')
        .select(['id', 'journey_id', 'reason', 'source', 'status', 'asked_at'])
        .where('id', '=', input.id)
        .executeTakeFirst();
      if (same) {
        if (same.journey_id !== journeyId)
          throw appError.conflict('This check-in id is already used.');
        return toCheckin(same);
      }
      if (journey.status !== 'active') throw appError.conflict('This journey has ended.');

      const open = await trx
        .selectFrom('checkins')
        .select(['id', 'reason', 'source', 'status', 'asked_at'])
        .where('journey_id', '=', journeyId)
        .where('status', '=', 'pending')
        .executeTakeFirst();
      if (open) return toCheckin(open);

      if (journey.checkins_paused_until && journey.checkins_paused_until > new Date()) {
        throw appError.conflict('Check-ins are paused ("Stuck in traffic").');
      }
      const recentFine = await trx
        .selectFrom('checkins')
        .select('id')
        .where('journey_id', '=', journeyId)
        .where('reason', '=', input.reason)
        .where('status', '=', 'fine')
        .where('answered_at', '>', sql<Date>`now() - make_interval(mins => ${FINE_QUIET_MINUTES})`)
        .executeTakeFirst();
      if (recentFine) {
        throw appError.conflict('You answered "I am fine" to this a moment ago.');
      }

      const row = await trx
        .insertInto('checkins')
        .values({ id: input.id, journey_id: journeyId, reason: input.reason, source: 'phone' })
        .returning(['id', 'reason', 'source', 'status', 'asked_at'])
        .executeTakeFirstOrThrow();
      replyWaitMinutes = journey.rules?.['checkin.reply_wait_minutes'] ?? 2;
      return toCheckin(row);
    });

    if (replyWaitMinutes !== null) {
      // No answer in time → guardians are alerted (the sweep also catches a missed timer).
      await this.jobs
        .add(
          'checkin-reply',
          { checkinId: checkin.id },
          { delayMs: replyWaitMinutes * 60_000, jobId: `checkin-reply-${checkin.id}` },
        )
        .catch(() => undefined);
    }
    return checkin;
  }

  /** "I'm fine", "Stuck in traffic" (pauses check-ins) or "I need help" (the app starts an SOS). */
  async answerCheckin(
    userId: string,
    checkinId: string,
    input: AnswerCheckinRequest,
  ): Promise<Checkin> {
    const checkin = await this.database.db
      .selectFrom('checkins as c')
      .innerJoin('journeys as j', 'j.id', 'c.journey_id')
      .select(['c.id', 'c.journey_id', 'c.status', 'j.rules'])
      .where('c.id', '=', checkinId)
      .where('j.user_id', '=', userId)
      .executeTakeFirst();
    if (!checkin) throw appError.notFound('Check-in not found.');

    // A late answer after the 2-minute alert is still recorded; an answered one can't change.
    if (checkin.status === 'pending' || checkin.status === 'no_reply') {
      const pause = checkin.rules?.['checkin.traffic_pause_minutes'] ?? 10;
      await this.database.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('checkins')
          .set({ status: input.answer, answered_at: sql<Date>`now()` })
          .where('id', '=', checkinId)
          .execute();
        if (input.answer === 'traffic_pause') {
          await trx
            .updateTable('journeys')
            .set({ checkins_paused_until: sql<Date>`now() + make_interval(mins => ${pause})` })
            .where('id', '=', checkin.journey_id)
            .execute();
        }
      });
    } else if (checkin.status !== input.answer) {
      throw appError.conflict('This check-in was already answered.');
    }

    const row = await this.database.db
      .selectFrom('checkins')
      .select(['id', 'reason', 'source', 'status', 'asked_at'])
      .where('id', '=', checkinId)
      .executeTakeFirstOrThrow();
    return toCheckin(row);
  }

  async get(userId: string, journeyId: string): Promise<Journey> {
    const j = await this.database.db
      .selectFrom('journeys')
      .select([
        'id',
        'status',
        'destination_label',
        sql<number>`ST_Y(destination::geometry)`.as('lat'),
        sql<number>`ST_X(destination::geometry)`.as('lng'),
        'expected_arrival_at',
        'started_at',
        'ended_at',
        'checkins_paused_until',
        'route_polyline',
      ])
      .where('id', '=', journeyId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!j) throw appError.notFound('Journey not found.');
    const open = await this.database.db
      .selectFrom('checkins')
      .select(['id', 'reason', 'source', 'status', 'asked_at'])
      .where('journey_id', '=', journeyId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return {
      id: j.id,
      status: j.status,
      destination: { lat: Number(j.lat), lng: Number(j.lng), label: j.destination_label ?? '' },
      expectedArrivalAt: j.expected_arrival_at!.toISOString(),
      startedAt: new Date(j.started_at).toISOString(),
      endedAt: j.ended_at?.toISOString() ?? null,
      openCheckin: open ? toCheckin(open) : null,
      checkinsPausedUntil:
        j.checkins_paused_until && j.checkins_paused_until > new Date()
          ? j.checkins_paused_until.toISOString()
          : null,
      route: j.route_polyline,
    };
  }

  private async own(
    userId: string,
    journeyId: string,
    db: Transaction<Database> | DatabaseService['db'] = this.database.db,
  ) {
    const journey = await db
      .selectFrom('journeys')
      .select(['id', 'status', 'rules', 'destination_label', 'checkins_paused_until'])
      .where('id', '=', journeyId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!journey) throw appError.notFound('Journey not found.');
    return journey;
  }

  private async linkedGuardians(journeyId: string): Promise<{ id: string; phone: string }[]> {
    const rows = await this.database.db
      .selectFrom('guardian_links as l')
      .innerJoin('guardians as g', 'g.id', 'l.guardian_id')
      .select(['g.id', 'g.phone'])
      .where('l.journey_id', '=', journeyId)
      .where('g.phone', 'is not', null)
      .where('g.invite_status', '=', 'accepted')
      .execute();
    return rows.map((r) => ({ id: r.id, phone: r.phone! }));
  }

  private async userName(userId: string): Promise<string> {
    const user = await this.database.db
      .selectFrom('users')
      .select('name')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    return user.name?.trim() || 'Someone who added you as a guardian';
  }
}
