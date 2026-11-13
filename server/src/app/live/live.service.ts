import { Injectable } from '@nestjs/common';
import type { LivePoint, LiveView } from '@sarthi/shared';
import { sql } from 'kysely';
import { DatabaseService } from '../../database/database.module';
import { RedisService } from '../../redis/redis.module';
import { StorageService } from '../../storage/storage.module';
import { hashLinkCode } from '../common/guardian-links';
import { appError } from '../common/app-http';
import { liveKeys } from '../locations/live-location';
import { OutgoingMessages } from '../messages/outgoing-messages';
import { LiveEvents } from './live-events';

const ENDED = 'This alert has ended.';

export interface OpenLink {
  linkId: string;
  guardianId: string;
  guardianName: string;
  kind: 'sos' | 'journey';
  /** The SOS or journey id. */
  id: string;
  userId: string;
  openedAt: Date | null;
  respondingAt: Date | null;
}

const firstName = (name: string | null | undefined, fallback: string) =>
  name?.trim().split(/\s+/)[0] || fallback;

/** How long a photo link on the live page works (the page refreshes before that). */
const PHOTO_LINK_SECONDS = 900;

/** The guardian's live page: what it shows, "I'm responding", and who may watch live updates. */
@Injectable()
export class LiveService {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
    private readonly messages: OutgoingMessages,
    private readonly events: LiveEvents,
    private readonly storage: StorageService,
  ) {}

  /** A link that still works, or `link_expired`. Unknown codes look the same as expired ones. */
  async findOpenLink(code: string): Promise<OpenLink> {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(code)) throw appError.linkExpired(ENDED);
    const link = await this.database.db
      .selectFrom('guardian_links as l')
      .innerJoin('guardians as g', 'g.id', 'l.guardian_id')
      .select([
        'l.id',
        'l.guardian_id',
        'g.name',
        'g.user_id',
        'l.sos_event_id',
        'l.journey_id',
        'l.opened_at',
        'l.responding_at',
      ])
      .where('l.token_hash', '=', hashLinkCode(code))
      .where('l.expires_at', '>', sql<Date>`now()`)
      .executeTakeFirst();
    if (!link) throw appError.linkExpired(ENDED);
    return {
      linkId: link.id,
      guardianId: link.guardian_id,
      guardianName: link.name,
      kind: link.sos_event_id ? 'sos' : 'journey',
      id: (link.sos_event_id ?? link.journey_id)!,
      userId: link.user_id,
      openedAt: link.opened_at,
      respondingAt: link.responding_at,
    };
  }

  /** Page data; the first open is recorded and shown to the user and the other guardians. */
  async view(code: string): Promise<LiveView> {
    const link = await this.findOpenLink(code);
    if (!link.openedAt) {
      const opened = await this.database.db
        .updateTable('guardian_links')
        .set({ opened_at: sql<Date>`now()` })
        .where('id', '=', link.linkId)
        .where('opened_at', 'is', null)
        .executeTakeFirst();
      if (opened.numUpdatedRows > 0n) {
        await this.events.changed(link.kind, link.id);
        await this.messages.notifyUser(
          link.userId,
          'guardian_status',
          `${firstName(link.guardianName, 'A guardian')} opened your live link`,
          link.kind === 'sos' ? 'They can see where you are.' : 'They are following your journey.',
          {
            [link.kind === 'sos' ? 'sosId' : 'journeyId']: link.id,
            guardianId: link.guardianId,
            status: 'opened',
          },
        );
      }
    }
    return this.build(link);
  }

  /** "I'm responding" (SOS only). Tapping again is fine. */
  async responding(code: string): Promise<LiveView> {
    const link = await this.findOpenLink(code);
    if (link.kind !== 'sos') throw appError.conflict('Only for an SOS.');
    const sos = await this.database.db
      .selectFrom('sos_events')
      .select('status')
      .where('id', '=', link.id)
      .executeTakeFirstOrThrow();
    if (sos.status !== 'active') throw appError.conflict('The SOS has ended.');

    const updated = await this.database.db
      .updateTable('guardian_links')
      .set({
        responding_at: sql<Date>`now()`,
        opened_at: sql<Date>`coalesce(opened_at, now())`,
      })
      .where('id', '=', link.linkId)
      .where('responding_at', 'is', null)
      .executeTakeFirst();
    if (updated.numUpdatedRows > 0n) {
      await this.events.changed('sos', link.id);
      await this.messages.notifyUser(
        link.userId,
        'guardian_status',
        `${firstName(link.guardianName, 'A guardian')} is responding`,
        'They are coming to help or trying to reach you.',
        { sosId: link.id, guardianId: link.guardianId, status: 'responding' },
      );
    }
    return this.build(await this.findOpenLink(code));
  }

  private async build(link: OpenLink): Promise<LiveView> {
    const db = this.database.db;
    const user = await db
      .selectFrom('users')
      .select(['name', 'phone', 'blood_group'])
      .where('id', '=', link.userId)
      .executeTakeFirstOrThrow();

    let status: LiveView['status'];
    let outcome: LiveView['outcome'] = null;
    let startedAt: Date;
    let endedAt: Date | null;
    let lostContact: boolean;
    let journey: LiveView['journey'] = null;
    let trigger: LiveView['trigger'] = null;

    if (link.kind === 'sos') {
      const sos = await db
        .selectFrom('sos_events')
        .select(['status', 'started_at', 'ended_at', 'lost_contact_at', 'trigger'])
        .where('id', '=', link.id)
        .executeTakeFirstOrThrow();
      trigger = sos.trigger;
      status = sos.status === 'active' ? 'active' : 'ended';
      if (status === 'ended') outcome = 'safe';
      startedAt = new Date(sos.started_at);
      endedAt = sos.ended_at;
      lostContact = sos.lost_contact_at !== null;
    } else {
      const j = await db
        .selectFrom('journeys')
        .select([
          'status',
          'started_at',
          'ended_at',
          'lost_contact_at',
          'destination_label',
          'expected_arrival_at',
          'route_polyline',
          'mode',
          sql<number>`ST_Y(destination::geometry)`.as('lat'),
          sql<number>`ST_X(destination::geometry)`.as('lng'),
        ])
        .where('id', '=', link.id)
        .executeTakeFirstOrThrow();
      status = j.status === 'active' ? 'active' : 'ended';
      if (j.status === 'arrived') outcome = 'arrived';
      else if (status === 'ended') outcome = 'ended';
      startedAt = j.started_at;
      endedAt = j.ended_at;
      lostContact = j.lost_contact_at !== null;
      journey = {
        destinationLabel: j.destination_label ?? '',
        destination: { lat: Number(j.lat), lng: Number(j.lng) },
        expectedArrivalAt: (j.expected_arrival_at ?? j.started_at).toISOString(),
        route: j.route_polyline,
        mode: j.mode ?? null,
      };
    }

    const location = await this.latestPoint(link);
    const beat = await this.redis.client
      .hget(liveKeys.heartbeat(link.userId), 'batteryPct')
      .catch(() => null);
    const beatBattery = beat ? Number(beat) : null;

    const links = await db
      .selectFrom('guardian_links as l')
      .innerJoin('guardians as g', 'g.id', 'l.guardian_id')
      .select(['l.id', 'g.name', 'l.opened_at', 'l.responding_at'])
      .where(link.kind === 'sos' ? 'l.sos_event_id' : 'l.journey_id', '=', link.id)
      .orderBy('l.created_at')
      .execute();

    const isSos = link.kind === 'sos';
    return {
      kind: link.kind,
      status,
      outcome,
      person: {
        firstName: firstName(user.name, 'Your contact'),
        phone: isSos ? user.phone : null,
        bloodGroup: isSos ? user.blood_group : null,
      },
      location,
      batteryPct: location?.batteryPct ?? (Number.isFinite(beatBattery) ? beatBattery : null),
      lostContact,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt ? endedAt.toISOString() : null,
      journey,
      guardians: links.map((l) => ({
        firstName: firstName(l.name, 'Guardian'),
        status: l.responding_at ? 'responding' : l.opened_at ? 'opened' : 'alerted',
        isYou: l.id === link.linkId,
      })),
      youAreResponding: link.respondingAt !== null,
      trigger,
      photos: isSos ? await this.photos(link.id) : [],
    };
  }

  /** SOS photos for the guardian: short-lived links, newest first (deleted ones are gone). */
  private async photos(sosId: string): Promise<LiveView['photos']> {
    const rows = await this.database.db
      .selectFrom('sos_photos')
      .select(['camera', 'storage_key', 'taken_at'])
      .where('sos_event_id', '=', sosId)
      .where('delete_after', '>', new Date())
      .orderBy('taken_at', 'desc')
      .limit(6)
      .execute();
    return Promise.all(
      rows.map(async (r) => ({
        camera: r.camera,
        url: await this.storage.downloadUrl(r.storage_key, PHOTO_LINK_SECONDS),
        takenAt: new Date(r.taken_at).toISOString(),
      })),
    );
  }

  /** Newest point: from Redis, or from the database if Redis has none. */
  private async latestPoint(link: OpenLink): Promise<LivePoint | null> {
    const cached = await this.redis.client
      .hget(liveKeys.latest(link.kind, link.id), 'point')
      .catch(() => null);
    if (cached) return JSON.parse(cached) as LivePoint;

    const row = await this.database.db
      .selectFrom('location_points')
      .select([
        sql<number>`ST_Y(location::geometry)`.as('lat'),
        sql<number>`ST_X(location::geometry)`.as('lng'),
        'accuracy_m',
        'battery_pct',
        'network',
        'recorded_at',
      ])
      .where(link.kind === 'sos' ? 'sos_event_id' : 'journey_id', '=', link.id)
      .orderBy('recorded_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!row) return null;
    return {
      sosId: link.kind === 'sos' ? link.id : null,
      journeyId: link.kind === 'journey' ? link.id : null,
      lat: Number(row.lat),
      lng: Number(row.lng),
      accuracyM: row.accuracy_m,
      batteryPct: row.battery_pct,
      network: row.network,
      recordedAt: new Date(row.recorded_at).toISOString(),
    };
  }
}
