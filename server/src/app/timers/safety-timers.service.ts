import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env.schema';
import { DatabaseService } from '../../database/database.module';
import { RedisService } from '../../redis/redis.module';
import { linkedGuardians, liveLinkUrl, userDisplayName } from '../common/guardian-links';
import { JobHandlers } from '../jobs/job-queue';
import { LiveEvents } from '../live/live-events';
import { liveKeys } from '../locations/live-location';
import { OutgoingMessages } from '../messages/outgoing-messages';

/** Defaults when an old SOS / journey has no rules copy. */
const DEFAULT_NO_RESPONSE_MINUTES = 5;
const DEFAULT_REPLY_WAIT_MINUTES = 2;
const DEFAULT_LOST_CONTACT_MINUTES = 5;

/** "11:42 pm" in India time. */
const indiaTime = (d: Date) =>
  new Intl.DateTimeFormat('en-IN', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata',
  }).format(d);

type Kind = 'sos' | 'journey';

interface Watched {
  kind: Kind;
  id: string;
  userId: string;
  startedAt: Date;
  lostContactAt: Date | null;
  rules: Record<string, number> | null;
}

/**
 * The server watches the clock: these run even if the phone dies.
 * - no guardian responded to an SOS (reminder SMS + push "Call 112"), once
 * - a check-in was not answered in time (SMS to accepted guardians)
 * - lost contact: the phone was silent too long during an SOS or journey (and "back online")
 */
@Injectable()
export class SafetyTimers implements OnModuleInit {
  private readonly logger = new Logger('SafetyTimers');

  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
    private readonly messages: OutgoingMessages,
    private readonly handlers: JobHandlers,
    private readonly live: LiveEvents,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    this.handlers.register('sos-no-response', (d) => this.noResponse(String(d.sosId)));
    this.handlers.register('checkin-reply', (d) => this.checkinReply(String(d.checkinId)));
    this.handlers.register('lost-contact-sweep', () => this.sweep());
  }

  /** No guardian tapped "I'm responding" in time: remind them once and show Call 112 on the phone. */
  async noResponse(sosId: string): Promise<void> {
    const db = this.database.db;
    const responder = await db
      .selectFrom('guardian_links')
      .select('id')
      .where('sos_event_id', '=', sosId)
      .where('responding_at', 'is not', null)
      .executeTakeFirst();
    if (responder) return;

    // Claimed with one update, so the reminder goes out once even if two workers run it.
    const sos = await db
      .updateTable('sos_events')
      .set({ no_response_alerted_at: sql<Date>`now()` })
      .where('id', '=', sosId)
      .where('status', '=', 'active')
      .where('is_test', '=', false)
      .where('no_response_alerted_at', 'is', null)
      .returning(['id', 'user_id'])
      .executeTakeFirst();
    if (!sos?.user_id) return;

    const name = await userDisplayName(db, sos.user_id);
    for (const g of await linkedGuardians(db, 'sos_event_id', sosId)) {
      await this.messages.sendSms(g.phone, {
        guardianId: g.guardianId,
        kind: 'resend',
        sosId,
        text: `REMINDER: ${name}'s SOS on Sarthi Rakshak is still active. Live location: ${liveLinkUrl(this.env, g.linkId)} If you can't reach them, call 112.`,
      });
    }
    await this.messages.notifyUser(
      sos.user_id,
      'show_call_112',
      'No guardian has responded yet',
      'Call 112 if you need help now.',
      { sosId },
    );
  }

  /** The check-in was not answered in time: tell the accepted guardians, with the live link. */
  async checkinReply(checkinId: string): Promise<void> {
    const db = this.database.db;
    const checkin = await db
      .updateTable('checkins')
      .set({ status: 'no_reply' })
      .where('id', '=', checkinId)
      .where('status', '=', 'pending')
      .where(
        'journey_id',
        'in',
        db.selectFrom('journeys').select('id').where('status', '=', 'active'),
      )
      .returning(['journey_id'])
      .executeTakeFirst();
    if (!checkin) return;

    const journey = await db
      .selectFrom('journeys')
      .select(['user_id', 'destination_label'])
      .where('id', '=', checkin.journey_id)
      .executeTakeFirstOrThrow();
    const name = await userDisplayName(db, journey.user_id);
    const place = journey.destination_label ?? 'their destination';
    for (const g of await linkedGuardians(db, 'journey_id', checkin.journey_id)) {
      if (g.inviteStatus !== 'accepted') continue;
      await this.messages.sendSms(g.phone, {
        guardianId: g.guardianId,
        kind: 'checkin_no_reply',
        journeyId: checkin.journey_id,
        text: `${name} did not answer a safety check on the way to ${place}. Live location: ${liveLinkUrl(this.env, g.linkId)}`,
      });
    }
    await this.messages.notifyUser(
      journey.user_id,
      'checkin_no_reply',
      'Your guardians were told',
      'You did not answer the safety check, so your guardians got your live location.',
      { journeyId: checkin.journey_id, checkinId },
    );
  }

  /**
   * Every 30 seconds: lost contact and back online; also runs timers that were missed (e.g. Redis
   * was down when they should have been queued) and re-queues SMS that never reached the queue.
   */
  async sweep(): Promise<void> {
    await this.lostContact();
    await this.missedTimers();
    await this.messages.requeueStuck();
  }

  private async lostContact(): Promise<void> {
    const db = this.database.db;
    const soses = await db
      .selectFrom('sos_events')
      .select(['id', 'user_id', 'journey_id', 'started_at', 'lost_contact_at', 'rules'])
      .where('status', '=', 'active')
      .where('is_test', '=', false)
      .where('user_id', 'is not', null)
      .execute();
    const journeys = await db
      .selectFrom('journeys')
      .select(['id', 'user_id', 'started_at', 'lost_contact_at', 'rules'])
      .where('status', '=', 'active')
      .execute();

    // During an SOS on a journey, the SOS messages cover it: no second message for the journey.
    const coveredJourneys = new Set(soses.map((s) => s.journey_id).filter(Boolean));
    const watched: Watched[] = [
      ...soses.map((s) => ({
        kind: 'sos' as const,
        id: s.id,
        userId: s.user_id!,
        startedAt: new Date(s.started_at),
        lostContactAt: s.lost_contact_at,
        rules: s.rules,
      })),
      ...journeys
        .filter((j) => !coveredJourneys.has(j.id))
        .map((j) => ({
          kind: 'journey' as const,
          id: j.id,
          userId: j.user_id,
          startedAt: j.started_at,
          lostContactAt: j.lost_contact_at,
          rules: j.rules,
        })),
    ];

    for (const item of watched) {
      try {
        await this.checkContact(item);
      } catch (err) {
        this.logger.error(
          `Lost-contact check failed for ${item.kind} ${item.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  /** Last time the server heard from the phone: heartbeat, location point, or the start. */
  private async lastContact(item: Watched): Promise<Date> {
    const beat = await this.redis.client.zscore(liveKeys.heartbeats, item.userId);
    const point = await this.database.db
      .selectFrom('location_points')
      .select((eb) => eb.fn.max('created_at').as('at'))
      .where(item.kind === 'sos' ? 'sos_event_id' : 'journey_id', '=', item.id)
      .executeTakeFirst();
    const times = [item.startedAt.getTime()];
    if (beat) times.push(Number(beat));
    if (point?.at) times.push(new Date(point.at).getTime());
    return new Date(Math.max(...times));
  }

  private async checkContact(item: Watched): Promise<void> {
    const minutes = item.rules?.['journey.lost_contact_minutes'] ?? DEFAULT_LOST_CONTACT_MINUTES;
    const last = await this.lastContact(item);
    const silent = Date.now() - last.getTime() >= minutes * 60_000;
    const table = item.kind === 'sos' ? 'sos_events' : 'journeys';
    const column = item.kind === 'sos' ? 'sos_event_id' : 'journey_id';
    const db = this.database.db;

    if (silent && !item.lostContactAt) {
      const claimed = await db
        .updateTable(table)
        .set({ lost_contact_at: sql<Date>`now()` })
        .where('id', '=', item.id)
        .where('status', '=', 'active')
        .where('lost_contact_at', 'is', null)
        .executeTakeFirst();
      if (claimed.numUpdatedRows === 0n) return;
      await this.live.changed(item.kind, item.id);
      const name = await userDisplayName(db, item.userId);
      for (const g of await linkedGuardians(db, column, item.id)) {
        if (item.kind === 'journey' && g.inviteStatus !== 'accepted') continue;
        await this.messages.sendSms(g.phone, {
          guardianId: g.guardianId,
          kind: 'lost_contact',
          ...(item.kind === 'sos' ? { sosId: item.id } : { journeyId: item.id }),
          text: `We lost contact with ${name}'s phone. Last location at ${indiaTime(last)}: ${liveLinkUrl(this.env, g.linkId)}`,
        });
      }
    } else if (!silent && item.lostContactAt) {
      const cleared = await db
        .updateTable(table)
        .set({ lost_contact_at: null })
        .where('id', '=', item.id)
        .where('lost_contact_at', 'is not', null)
        .executeTakeFirst();
      if (cleared.numUpdatedRows === 0n) return;
      await this.live.changed(item.kind, item.id);
      const name = await userDisplayName(db, item.userId);
      for (const g of await linkedGuardians(db, column, item.id)) {
        if (item.kind === 'journey' && g.inviteStatus !== 'accepted') continue;
        await this.messages.sendSms(g.phone, {
          guardianId: g.guardianId,
          kind: 'back_online',
          ...(item.kind === 'sos' ? { sosId: item.id } : { journeyId: item.id }),
          text: `${name}'s phone is back online. Live location: ${liveLinkUrl(this.env, g.linkId)}`,
        });
      }
    }
  }

  /** Timers whose job never ran (they are safe to run twice). */
  private async missedTimers(): Promise<void> {
    const db = this.database.db;
    const soses = await db
      .selectFrom('sos_events')
      .select('id')
      .where('status', '=', 'active')
      .where('is_test', '=', false)
      .where('no_response_alerted_at', 'is', null)
      .where(
        sql<boolean>`started_at + make_interval(mins => coalesce((rules->>'sos.no_response_minutes')::int, ${DEFAULT_NO_RESPONSE_MINUTES})) + interval '1 minute' < now()`,
      )
      .execute();
    for (const s of soses) await this.noResponse(s.id);

    const checkins = await db
      .selectFrom('checkins as c')
      .innerJoin('journeys as j', 'j.id', 'c.journey_id')
      .select('c.id')
      .where('c.status', '=', 'pending')
      .where('j.status', '=', 'active')
      .where(
        sql<boolean>`c.asked_at + make_interval(mins => coalesce((j.rules->>'checkin.reply_wait_minutes')::int, ${DEFAULT_REPLY_WAIT_MINUTES})) + interval '1 minute' < now()`,
      )
      .execute();
    for (const c of checkins) await this.checkinReply(c.id);
  }
}
