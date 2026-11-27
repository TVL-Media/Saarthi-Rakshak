import { Body, Controller, HttpCode, Inject, Injectable, Post, Req } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env.schema';
import { DatabaseService } from '../../database/database.module';
import { appError, parseAppBody, type AppRequest } from '../common/app-http';
import { AppRateLimiter } from '../common/rate-limit';
import { Phase4Gate } from '../phase4/common';
import { decodePolyline, sampleRoute, scoreRoute, type NearbyPoint, type RouteScore, type ScoringConfig } from './scoring';

const routeBody = z.object({
  from: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
  to: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
  mode: z.enum(['walking', 'driving', 'bicycling', 'transit']).default('walking'),
});
const feedbackBody = z.object({
  id: z.uuid(),
  routeScoreId: z.uuid().nullish(),
  kind: z.enum(['inaccurate', 'unsafe_area', 'closed_road', 'other']),
  message: z.string().trim().min(5).max(500),
});

interface ProviderRoute {
  summary: string;
  distanceM: number;
  durationS: number;
  path: [number, number][];
  /** The provider's encoded route, handed back so a journey can start on exactly this route. */
  polyline: string;
}

export const SAFE_ROUTE_NOTICE =
  'Safety scores are advice based on reported data and nearby support. They are not a guarantee and never replace your own judgement. ' +
  'The fastest route is always shown so you can choose. Missing data is never treated as safe.';

@Injectable()
export class SafetyScoringService {
  constructor(
    private readonly database: DatabaseService,
    private readonly gate: Phase4Gate,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private get db() {
    return this.database.db;
  }

  /** Candidate routes from the routing provider (Google Directions, key kept on the server). */
  async providerRoutes(input: z.infer<typeof routeBody>): Promise<ProviderRoute[] | null> {
    const key = this.env.GOOGLE_DIRECTIONS_API_KEY ?? this.env.GOOGLE_PLACES_API_KEY;
    if (!key) return null;
    const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
    url.searchParams.set('origin', `${input.from.lat},${input.from.lng}`);
    url.searchParams.set('destination', `${input.to.lat},${input.to.lng}`);
    url.searchParams.set('mode', input.mode);
    url.searchParams.set('alternatives', 'true');
    url.searchParams.set('key', key);
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`routes ${res.status}`);
    const body = (await res.json()) as {
      status: string;
      routes?: { summary?: string; overview_polyline: { points: string }; legs: { distance: { value: number }; duration: { value: number } }[] }[];
    };
    if (body.status === 'ZERO_RESULTS') return [];
    if (body.status !== 'OK') throw new Error(`routes ${body.status}`);
    return (body.routes ?? []).map((r) => ({
      summary: r.summary ?? 'Route',
      distanceM: r.legs.reduce((a, l) => a + l.distance.value, 0),
      durationS: r.legs.reduce((a, l) => a + l.duration.value, 0),
      path: decodePolyline(r.overview_polyline.points),
      polyline: r.overview_polyline.points,
    }));
  }

  private async activeModel() {
    const r = await sql<{ version: string; config: ScoringConfig }>`SELECT version, config FROM safety_models WHERE active ORDER BY created_at DESC LIMIT 1`.execute(this.db);
    return r.rows[0] ?? null;
  }

  private async signals(samples: [number, number][], cfg: ScoringConfig) {
    if (samples.length === 0) return [];
    const lats = samples.map((s) => s[0]);
    const lngs = samples.map((s) => s[1]);
    const radius = cfg.coverageRadiusM ?? 500;
    const r = await sql<{ i: number; category: string; weight: number; source_time: Date | null; dist: number }>`
      SELECT s.i::int AS i, p.category, p.weight, p.source_time,
             ST_Distance(p.location, ST_SetSRID(ST_MakePoint(s.lng, s.lat), 4326)::geography) AS dist
        FROM unnest(${lats}::float8[], ${lngs}::float8[]) WITH ORDINALITY AS s(lat, lng, i)
        JOIN safety_points p
          ON ST_DWithin(p.location, ST_SetSRID(ST_MakePoint(s.lng, s.lat), 4326)::geography, ${radius})
        JOIN safety_datasets d ON d.id = p.dataset_id AND d.status = 'active'`.execute(this.db);
    const byIndex = new Map<number, NearbyPoint[]>();
    for (const row of r.rows) {
      const list = byIndex.get(row.i) ?? [];
      list.push({ category: row.category, weight: row.weight, sourceTime: row.source_time ? row.source_time.toISOString() : null, distM: row.dist });
      byIndex.set(row.i, list);
    }
    return samples.map((s, idx) => ({ lat: s[0], lng: s[1], points: byIndex.get(idx + 1) ?? [] }));
  }

  async routes(userId: string, input: z.infer<typeof routeBody>) {
    await this.gate.require('feature.safe_route');
    const model = await this.activeModel();
    let routes: ProviderRoute[] | null;
    try {
      routes = await this.providerRoutes(input);
    } catch {
      throw appError.serviceUnavailable('Routes are not available right now. Please try again.');
    }
    if (routes === null) {
      return { providerAvailable: false, message: 'Route suggestions are not set up yet.', notice: SAFE_ROUTE_NOTICE, items: [], routeScoreId: null };
    }
    const asOf = new Date();
    const stale = await sql<{ name: string }>`
      SELECT name FROM safety_datasets WHERE status = 'active'
         AND (last_imported_at IS NULL OR last_imported_at < now() - make_interval(days => refresh_days))`.execute(this.db);
    const active = await sql<{ n: string }>`SELECT count(*) AS n FROM safety_datasets WHERE status = 'active'`.execute(this.db);
    const items: unknown[] = [];
    let fastest = 0;
    routes.forEach((r, i) => { if (r.durationS < routes![fastest].durationS) fastest = i; });
    for (const [i, r] of routes.entries()) {
      let score: RouteScore | null = null;
      if (model && Number(active.rows[0].n) > 0) {
        const samples = await this.signals(sampleRoute(r.path, model.config.sampleEveryM), model.config);
        score = scoreRoute(samples, model.config, asOf);
      }
      items.push({
        index: i, summary: r.summary, distanceM: r.distanceM, etaMinutes: Math.round(r.durationS / 60),
        isFastest: i === fastest, polyline: r.polyline, path: r.path.filter((_, k) => k % 3 === 0 || k === r.path.length - 1),
        score: score ?? { band: 'unknown', riskIndex: null, confidence: 'none', coverage: 0, samples: 0, factors: [], newestDataAt: null, note: 'No safety data is switched on yet.' },
      });
    }
    // Safer first, only when a score exists. Missing data never ranks a route as safer.
    const order = (x: any) => (x.score.riskIndex === null ? Number.POSITIVE_INFINITY : x.score.riskIndex);
    (items as any[]).sort((a, b) => order(a) - order(b) || a.etaMinutes - b.etaMinutes);
    const saved = await sql<{ id: string }>`
      INSERT INTO safety_route_scores (user_id, model_version, input_snapshot, result)
      VALUES (${userId}, ${model?.version ?? 'none'}, ${JSON.stringify({ from: input.from, to: input.to, mode: input.mode, asOf: asOf.toISOString(), config: model?.config ?? null })}, ${JSON.stringify(items)})
      RETURNING id`.execute(this.db);
    return {
      providerAvailable: true,
      message: items.length === 0 ? 'No routes were found.' : null,
      notice: SAFE_ROUTE_NOTICE,
      modelVersion: model?.version ?? null,
      scoredAt: asOf.toISOString(),
      staleSources: stale.rows.map((s) => s.name),
      routeScoreId: saved.rows[0].id,
      items,
    };
  }

  async feedback(userId: string, input: z.infer<typeof feedbackBody>) {
    await this.gate.require('feature.safe_route');
    await sql`
      INSERT INTO safety_feedback (id, user_id, route_score_id, kind, message)
      VALUES (${input.id}, ${userId}, ${input.routeScoreId ?? null}, ${input.kind}, ${input.message})
      ON CONFLICT (id) DO NOTHING`.execute(this.db);
    return { ok: true, status: 'new' };
  }

  // -- Admin: datasets, import, models, feedback ---------------------------------------------

  async datasets() {
    const r = await sql<{ id: string; name: string; kind: string; source: string; licence: string; refresh_days: number; status: string; last_imported_at: Date | null; record_count: number }>`
      SELECT * FROM safety_datasets ORDER BY created_at DESC`.execute(this.db);
    return { items: r.rows.map((d) => ({ id: d.id, name: d.name, kind: d.kind, source: d.source, licence: d.licence, refreshDays: d.refresh_days, status: d.status, lastImportedAt: d.last_imported_at ? d.last_imported_at.toISOString() : null, records: d.record_count, stale: d.status === 'active' && (!d.last_imported_at || Date.now() - d.last_imported_at.getTime() > d.refresh_days * 86_400_000) })) };
  }

  async createDataset(input: { name: string; kind: string; source: string; licence: string; refreshDays: number }) {
    const r = await sql<{ id: string }>`INSERT INTO safety_datasets (name, kind, source, licence, refresh_days)
      VALUES (${input.name}, ${input.kind}, ${input.source}, ${input.licence}, ${input.refreshDays}) RETURNING id`.execute(this.db);
    return { id: r.rows[0].id };
  }

  async setDatasetStatus(id: string, status: 'draft' | 'active' | 'paused') {
    const r = await sql`UPDATE safety_datasets SET status = ${status} WHERE id = ${id} RETURNING id`.execute(this.db);
    if (r.rows.length === 0) throw appError.notFound('Dataset not found.');
    return { ok: true };
  }

  /** Records are checked one by one. Bad ones are quarantined with a reason. */
  async importRecords(id: string, records: unknown[]) {
    const ds = await sql`SELECT 1 FROM safety_datasets WHERE id = ${id}`.execute(this.db);
    if (ds.rows.length === 0) throw appError.notFound('Dataset not found.');
    const rec = z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      category: z.string().trim().min(2).max(40),
      weight: z.number().min(0).max(1),
      sourceTime: z.iso.datetime({ offset: true }).optional(),
    });
    let accepted = 0;
    let rejected = 0;
    for (const raw of records) {
      const p = rec.safeParse(raw);
      if (!p.success) {
        rejected++;
        await sql`INSERT INTO safety_import_rejects (dataset_id, reason, raw) VALUES (${id}, ${p.error.issues[0]?.message ?? 'Invalid'}, ${JSON.stringify(raw).slice(0, 500)})`.execute(this.db);
        continue;
      }
      await sql`INSERT INTO safety_points (dataset_id, location, category, weight, source_time)
        VALUES (${id}, ST_SetSRID(ST_MakePoint(${p.data.lng}, ${p.data.lat}), 4326)::geography, ${p.data.category}, ${p.data.weight}, ${p.data.sourceTime ?? null})`.execute(this.db);
      accepted++;
    }
    await sql`UPDATE safety_datasets SET last_imported_at = now(),
      record_count = (SELECT count(*) FROM safety_points WHERE dataset_id = ${id}) WHERE id = ${id}`.execute(this.db);
    return { accepted, rejected };
  }

  async models() {
    const r = await sql<{ id: string; version: string; config: unknown; active: boolean; created_at: Date }>`SELECT * FROM safety_models ORDER BY created_at DESC`.execute(this.db);
    return { items: r.rows.map((m) => ({ id: m.id, version: m.version, config: m.config, active: m.active, createdAt: m.created_at.toISOString() })) };
  }

  async addModel(version: string, config: ScoringConfig, activate: boolean) {
    try {
      const r = await sql<{ id: string }>`INSERT INTO safety_models (version, config, active) VALUES (${version}, ${JSON.stringify(config)}, false) RETURNING id`.execute(this.db);
      if (activate) await this.activateModel(r.rows[0].id);
      return { id: r.rows[0].id };
    } catch (e) {
      if (e instanceof Error && 'status' in e) throw e;
      throw appError.conflict('That model version already exists.');
    }
  }

  async activateModel(id: string) {
    const r = await sql`UPDATE safety_models SET active = (id = ${id}) WHERE EXISTS (SELECT 1 FROM safety_models WHERE id = ${id}) RETURNING id`.execute(this.db);
    if (r.rows.length === 0) throw appError.notFound('Model not found.');
    return { ok: true };
  }

  async feedbackQueue() {
    const r = await sql<{ id: string; kind: string; message: string; status: string; created_at: Date }>`
      SELECT id, kind, message, status, created_at FROM safety_feedback ORDER BY created_at DESC LIMIT 200`.execute(this.db);
    return { items: r.rows.map((f) => ({ id: f.id, kind: f.kind, message: f.message, status: f.status, createdAt: f.created_at.toISOString() })) };
  }

  async reviewFeedback(adminId: string, id: string, status: 'reviewed' | 'actioned' | 'rejected') {
    const r = await sql`UPDATE safety_feedback SET status = ${status}, reviewed_by = ${adminId} WHERE id = ${id} RETURNING id`.execute(this.db);
    if (r.rows.length === 0) throw appError.notFound('Feedback not found.');
    return { ok: true };
  }
}

@Controller('v1/safe-route')
export class SafeRouteController {
  constructor(private readonly service: SafetyScoringService, private readonly limiter: AppRateLimiter) {}

  @Post('routes')
  @HttpCode(200)
  async routes(@Req() req: AppRequest, @Body() body: unknown) {
    await this.limiter.check(`safe-route:${req.user!.id}`, 60, 3600);
    return this.service.routes(req.user!.id, parseAppBody(routeBody, body));
  }

  @Post('feedback')
  @HttpCode(200)
  feedback(@Req() req: AppRequest, @Body() body: unknown) {
    return this.service.feedback(req.user!.id, parseAppBody(feedbackBody, body));
  }
}
