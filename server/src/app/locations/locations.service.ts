import { Injectable } from '@nestjs/common';
import type { HeartbeatRequest, LocationPoint, LocationsReply } from '@sarthi/shared';
import { sql } from 'kysely';
import { DatabaseService } from '../../database/database.module';
import { RedisService } from '../../redis/redis.module';
import { appError } from '../common/app-http';
import { LATEST_TTL_SECONDS, liveKeys, type LivePoint } from './live-location';

/** Points are still accepted this long after an SOS or journey ends (late uploads). */
const GRACE_AFTER_END_MS = 2 * 60_000;
/** A phone clock may be a little ahead. */
const MAX_CLOCK_AHEAD_MS = 60_000;
/** Points saved offline may arrive late, but not older than this. */
const MAX_POINT_AGE_MS = 24 * 3600_000;
/** The phone's "last seen" is written at most this often. */
const DEVICE_SEEN_EVERY_SECONDS = 60;

interface Target {
  status: string;
  ended_at: Date | null;
}

@Injectable()
export class LocationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  async save(userId: string, points: LocationPoint[]): Promise<LocationsReply> {
    const now = Date.now();
    for (const p of points) {
      const t = Date.parse(p.recordedAt);
      if (t > now + MAX_CLOCK_AHEAD_MS) {
        throw appError.invalidInput("recordedAt: Is in the future. Check the phone's clock.");
      }
      if (t < now - MAX_POINT_AGE_MS)
        throw appError.invalidInput('recordedAt: Is more than a day old.');
    }
    await this.checkTargets(userId, points, now);

    const inserted = await this.database.db
      .insertInto('location_points')
      .values(
        points.map((p) => ({
          user_id: userId,
          client_point_id: p.clientPointId,
          sos_event_id: p.sosId ?? null,
          journey_id: p.journeyId ?? null,
          location: sql<string>`ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)::geography`,
          accuracy_m: p.accuracyM ?? null,
          battery_pct: p.batteryPct ?? null,
          network: p.network ?? null,
          recorded_at: p.recordedAt,
        })),
      )
      .onConflict((oc) =>
        oc
          .columns(['user_id', 'client_point_id'])
          .where('client_point_id', 'is not', null)
          .doNothing(),
      )
      .returning('client_point_id')
      .execute();

    const savedIds = new Set(inserted.map((r) => r.client_point_id));
    const saved = points
      .filter((p) => savedIds.has(p.clientPointId))
      .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
    await this.publish(saved);
    return { saved: saved.length, duplicates: points.length - saved.length };
  }

  async heartbeat(
    userId: string,
    sessionDevice: string | null,
    beat: HeartbeatRequest,
  ): Promise<void> {
    if (beat.sosId || beat.journeyId) {
      await this.checkTargets(
        userId,
        [{ sosId: beat.sosId, journeyId: beat.journeyId }],
        Date.now(),
      );
    }
    const now = Date.now();
    await this.redis.client
      .multi()
      .zadd(liveKeys.heartbeats, now, userId)
      .hset(liveKeys.heartbeat(userId), {
        at: new Date(now).toISOString(),
        batteryPct: beat.batteryPct ?? '',
        network: beat.network ?? '',
        sosId: beat.sosId ?? '',
        journeyId: beat.journeyId ?? '',
      })
      .expire(liveKeys.heartbeat(userId), LATEST_TTL_SECONDS)
      .exec();

    // The admin panel shows the phone's "last seen"; written at most once a minute.
    if (sessionDevice) {
      const first = await this.redis.client.set(
        `seen:device:${sessionDevice}`,
        '1',
        'EX',
        DEVICE_SEEN_EVERY_SECONDS,
        'NX',
      );
      if (first) {
        await this.database.db
          .updateTable('devices')
          .set({ last_seen_at: sql<Date>`now()` })
          .where('id', '=', sessionDevice)
          .where('user_id', '=', userId)
          .execute();
      }
    }
  }

  /** Every SOS / journey named must be the user's own, and active or ended a moment ago. */
  private async checkTargets(
    userId: string,
    points: { sosId?: string; journeyId?: string }[],
    now: number,
  ): Promise<void> {
    const sosIds = [...new Set(points.flatMap((p) => (p.sosId ? [p.sosId] : [])))];
    const journeyIds = [...new Set(points.flatMap((p) => (p.journeyId ? [p.journeyId] : [])))];
    const open = (t: Target) =>
      t.status === 'active' ||
      (t.ended_at !== null && now - t.ended_at.getTime() <= GRACE_AFTER_END_MS);

    if (sosIds.length > 0) {
      const rows = await this.database.db
        .selectFrom('sos_events')
        .select(['id', 'status', 'ended_at'])
        .where('id', 'in', sosIds)
        .where('user_id', '=', userId)
        .execute();
      if (rows.length !== sosIds.length) throw appError.notFound('SOS not found.');
      if (!rows.every(open)) throw appError.conflict('This SOS has ended.');
    }
    if (journeyIds.length > 0) {
      const rows = await this.database.db
        .selectFrom('journeys')
        .select(['id', 'status', 'ended_at'])
        .where('id', 'in', journeyIds)
        .where('user_id', '=', userId)
        .execute();
      if (rows.length !== journeyIds.length) throw appError.notFound('Journey not found.');
      if (!rows.every(open)) throw appError.conflict('This journey has ended.');
    }
  }

  /** Newest point per SOS / journey into Redis, and every new point to its live channel. */
  private async publish(points: LocationPoint[]): Promise<void> {
    if (points.length === 0) return;
    const multi = this.redis.client.multi();
    for (const p of points) {
      const live: LivePoint = {
        sosId: p.sosId ?? null,
        journeyId: p.journeyId ?? null,
        lat: p.lat,
        lng: p.lng,
        accuracyM: p.accuracyM ?? null,
        batteryPct: p.batteryPct ?? null,
        network: p.network ?? null,
        recordedAt: new Date(p.recordedAt).toISOString(),
      };
      const json = JSON.stringify(live);
      for (const [kind, id] of [
        ['sos', p.sosId],
        ['journey', p.journeyId],
      ] as const) {
        if (!id) continue;
        multi.publish(liveKeys.channel(kind, id), json);
        // Only move "latest" forward: an old point arriving late never replaces a newer one.
        multi.eval(
          `local cur = redis.call('HGET', KEYS[1], 'recordedAt')
           if (not cur) or cur < ARGV[1] then
             redis.call('HSET', KEYS[1], 'recordedAt', ARGV[1], 'point', ARGV[2])
           end
           redis.call('EXPIRE', KEYS[1], ARGV[3])
           return 1`,
          1,
          liveKeys.latest(kind, id),
          live.recordedAt,
          json,
          LATEST_TTL_SECONDS,
        );
      }
    }
    await multi.exec();
  }
}
