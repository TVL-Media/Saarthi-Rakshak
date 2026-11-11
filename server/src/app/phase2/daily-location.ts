import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  DailyPointsRequest,
  DayParam,
  UpdateDailyTracking,
  type DailyTracking,
  type Timeline,
  type TimelineRoute,
  type TimelineStop,
  type TimelineSummary,
} from '@sarthi/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.module';
import { appError, parseAppBody, type AppRequest } from '../common/app-http';
import { AppRateLimiter } from '../common/rate-limit';

const DAY_MS = 86_400_000;
/** India time (the pilot is in Noida): a "day" in the timeline is an India day. */
const IST_OFFSET = '+05:30';
/** A stop: the phone stayed within this distance … */
const STOP_RADIUS_M = 100;
/** … for at least this long. */
const STOP_MIN_MS = 5 * 60_000;
/** Points older than this are refused (the phone keeps up to 7 days offline). */
const MAX_POINT_AGE_MS = 8 * DAY_MS;
const MAX_ROUTE_POINTS = 200;
/** The consent text version the app shows before turning full-day location on. */
export const DAILY_CONSENT_VERSION = '2026-11';

interface Pt {
  lat: number;
  lng: number;
  at: number;
}

/** Full-day location (features 7–11): only the user herself ever sees it. */
@Injectable()
export class DailyLocationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly rateLimiter: AppRateLimiter,
  ) {}

  async get(userId: string): Promise<DailyTracking> {
    const row = await this.database.db
      .selectFrom('daily_tracking_settings')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!row) return { enabled: false, pausedUntil: null, retentionDays: 30, consentVersion: null };
    return {
      enabled: row.enabled,
      pausedUntil:
        row.paused_until && row.paused_until > new Date() ? row.paused_until.toISOString() : null,
      retentionDays: row.retention_days as 7 | 30 | 90,
      consentVersion: row.consent_version,
    };
  }

  async update(userId: string, change: UpdateDailyTracking): Promise<DailyTracking> {
    const current = await this.get(userId);
    if (change.enabled === true && !current.consentVersion && !change.consentVersion) {
      throw appError.invalidInput('consentVersion: Accept the full-day location terms first.');
    }
    const values = {
      enabled: change.enabled ?? current.enabled,
      paused_until:
        change.pausedUntil === undefined
          ? current.pausedUntil
            ? new Date(current.pausedUntil)
            : null
          : change.pausedUntil
            ? new Date(change.pausedUntil)
            : null,
      retention_days: change.retentionDays ?? current.retentionDays,
      ...(change.consentVersion && {
        consent_version: change.consentVersion,
        consent_at: sql<Date>`now()`,
      }),
    };
    await this.database.db
      .insertInto('daily_tracking_settings')
      .values({ user_id: userId, ...values })
      .onConflict((oc) => oc.column('user_id').doUpdateSet(values))
      .execute();
    // A shorter keep period applies to points already saved too.
    if (change.retentionDays !== undefined && change.retentionDays !== current.retentionDays) {
      await this.database.db
        .updateTable('location_points')
        .set({
          delete_after: sql<Date>`recorded_at + make_interval(days => ${change.retentionDays})`,
        })
        .where('user_id', '=', userId)
        .where('kind', '=', 'daily')
        .execute();
    }
    return this.get(userId);
  }

  /** Saves a batch of full-day points; a point sent twice is saved once. */
  async addPoints(userId: string, input: DailyPointsRequest): Promise<{ saved: number }> {
    await this.rateLimiter.check(`daily-points:${userId}`, 600, 3600);
    const settings = await this.get(userId);
    if (!settings.enabled) throw appError.conflict('Full-day location is off.');
    const now = Date.now();
    const rows = input.points
      .filter((p) => {
        const t = new Date(p.recordedAt).getTime();
        return t <= now + 60_000 && t >= now - MAX_POINT_AGE_MS;
      })
      .map((p) => ({
        user_id: userId,
        client_point_id: p.clientPointId,
        kind: 'daily' as const,
        location: sql<string>`ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)::geography`,
        accuracy_m: p.accuracyM ?? null,
        battery_pct: p.batteryPct ?? null,
        network: null,
        recorded_at: p.recordedAt,
        delete_after: new Date(new Date(p.recordedAt).getTime() + settings.retentionDays * DAY_MS),
      }));
    if (rows.length === 0) return { saved: 0 };
    const result = await this.database.db
      .insertInto('location_points')
      .values(rows)
      .onConflict((oc) =>
        oc
          .columns(['user_id', 'client_point_id'])
          .where('client_point_id', 'is not', null)
          .doNothing(),
      )
      .executeTakeFirst();
    return { saved: Number(result.numInsertedOrUpdatedRows ?? 0) };
  }

  async deleteDay(userId: string, date: string): Promise<{ deleted: number }> {
    let q = this.database.db
      .deleteFrom('location_points')
      .where('user_id', '=', userId)
      .where('kind', '=', 'daily');
    if (date !== 'all') {
      const { from, to } = dayBounds(date);
      q = q.where('recorded_at', '>=', from).where('recorded_at', '<', to);
    }
    const result = await q.executeTakeFirst();
    return { deleted: Number(result.numDeletedRows) };
  }

  async timeline(userId: string, date: string): Promise<Timeline> {
    const points = await this.dayPoints(userId, date);
    const { stops, routes } = buildTimeline(points);
    return { date, stops, routes, pointsCount: points.length };
  }

  async summary(userId: string, date: string): Promise<TimelineSummary> {
    const points = await this.dayPoints(userId, date);
    const { stops, routes } = buildTimeline(points);
    const movingMs = routes.reduce(
      (sum, r) => sum + (new Date(r.to).getTime() - new Date(r.from).getTime()),
      0,
    );
    return {
      date,
      distanceM: routes.reduce((sum, r) => sum + r.distanceM, 0),
      stopsCount: stops.length,
      movingMinutes: Math.round(movingMs / 60_000),
      firstPointAt: points.length ? new Date(points[0].at).toISOString() : null,
      lastPointAt: points.length ? new Date(points[points.length - 1].at).toISOString() : null,
    };
  }

  private async dayPoints(userId: string, date: string): Promise<Pt[]> {
    const { from, to } = dayBounds(date);
    const rows = await this.database.db
      .selectFrom('location_points')
      .select([
        sql<number>`ST_Y(location::geometry)`.as('lat'),
        sql<number>`ST_X(location::geometry)`.as('lng'),
        'recorded_at',
      ])
      .where('user_id', '=', userId)
      .where('kind', '=', 'daily')
      .where('recorded_at', '>=', from)
      .where('recorded_at', '<', to)
      .orderBy('recorded_at')
      .limit(20_000)
      .execute();
    return rows.map((r) => ({
      lat: Number(r.lat),
      lng: Number(r.lng),
      at: new Date(r.recorded_at).getTime(),
    }));
  }
}

export function dayBounds(date: string): { from: Date; to: Date } {
  const from = new Date(`${date}T00:00:00${IST_OFFSET}`);
  if (Number.isNaN(from.getTime()))
    throw appError.invalidInput('date: Must be a date (YYYY-MM-DD)');
  return { from, to: new Date(from.getTime() + DAY_MS) };
}

export function distanceM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Stops = the phone stayed within 100 m of where it arrived for 5 minutes or more; routes = the
 * movement between stops (with distance and thinned points for the map).
 */
export function buildTimeline(points: Pt[]): { stops: TimelineStop[]; routes: TimelineRoute[] } {
  const stops: TimelineStop[] = [];
  const stopRanges: [number, number][] = [];
  let i = 0;
  while (i < points.length) {
    let j = i;
    while (j + 1 < points.length && distanceM(points[i], points[j + 1]) <= STOP_RADIUS_M) j++;
    if (points[j].at - points[i].at >= STOP_MIN_MS) {
      const group = points.slice(i, j + 1);
      stops.push({
        lat: group.reduce((s, p) => s + p.lat, 0) / group.length,
        lng: group.reduce((s, p) => s + p.lng, 0) / group.length,
        arrivedAt: new Date(points[i].at).toISOString(),
        leftAt: new Date(points[j].at).toISOString(),
        minutes: Math.round((points[j].at - points[i].at) / 60_000),
      });
      stopRanges.push([i, j]);
      i = j + 1;
    } else {
      i++;
    }
  }

  const routes: TimelineRoute[] = [];
  const addRoute = (a: number, b: number) => {
    if (b <= a) return;
    const seg = points.slice(a, b + 1);
    let dist = 0;
    for (let k = 1; k < seg.length; k++) dist += distanceM(seg[k - 1], seg[k]);
    if (dist < 50) return;
    const step = Math.max(1, Math.ceil(seg.length / MAX_ROUTE_POINTS));
    const thin = seg.filter((_, k) => k % step === 0 || k === seg.length - 1);
    routes.push({
      from: new Date(seg[0].at).toISOString(),
      to: new Date(seg[seg.length - 1].at).toISOString(),
      distanceM: Math.round(dist),
      points: thin.map((p) => [p.lat, p.lng] as [number, number]),
    });
  };
  let start = 0;
  for (const [a, b] of stopRanges) {
    addRoute(start, a);
    start = b;
  }
  if (points.length) addRoute(start, points.length - 1);
  return { stops, routes };
}

const dateQuery = z.object({ date: DayParam });
const deleteQuery = z.union([z.object({ date: DayParam }), z.object({ all: z.literal('true') })]);

@Controller('v1')
export class DailyLocationController {
  constructor(private readonly daily: DailyLocationService) {}

  @Get('me/daily-tracking')
  get(@Req() req: AppRequest): Promise<DailyTracking> {
    return this.daily.get(req.user!.id);
  }

  @Put('me/daily-tracking')
  put(@Req() req: AppRequest, @Body() body: unknown): Promise<DailyTracking> {
    return this.daily.update(req.user!.id, parseAppBody(UpdateDailyTracking, body));
  }

  @Post('daily-locations')
  @HttpCode(200)
  add(@Req() req: AppRequest, @Body() body: unknown): Promise<{ saved: number }> {
    return this.daily.addPoints(req.user!.id, parseAppBody(DailyPointsRequest, body));
  }

  @Delete('daily-locations')
  @HttpCode(200)
  remove(@Req() req: AppRequest, @Query() query: unknown): Promise<{ deleted: number }> {
    const q = parseAppBody(deleteQuery, query);
    return this.daily.deleteDay(req.user!.id, 'date' in q ? q.date : 'all');
  }

  @Get('timeline')
  timeline(@Req() req: AppRequest, @Query() query: unknown): Promise<Timeline> {
    return this.daily.timeline(req.user!.id, parseAppBody(dateQuery, query).date);
  }

  @Get('timeline/summary')
  summary(@Req() req: AppRequest, @Query() query: unknown): Promise<TimelineSummary> {
    return this.daily.summary(req.user!.id, parseAppBody(dateQuery, query).date);
  }
}
