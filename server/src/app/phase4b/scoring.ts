// Pure, repeatable safety scoring. The same inputs and model version always give the same result.
// The score is advice about reported incidents and nearby support. It never says a route is "safe".

export interface ScoringConfig {
  radiusM: number;
  sampleEveryM: number;
  minCoverage: number;
  coverageRadiusM?: number;
  scale?: number;
  categoryWeights: Record<string, number>;
  halfLifeDays: number;
  bands: [number, string][];
}

export interface NearbyPoint {
  category: string;
  weight: number;
  sourceTime: string | null;
  distM: number;
}

export interface SampleInput {
  lat: number;
  lng: number;
  points: NearbyPoint[];
}

export type Band = 'lower_risk' | 'some_risk' | 'higher_risk' | 'unknown';

export interface RouteScore {
  band: Band;
  riskIndex: number | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  coverage: number;
  samples: number;
  factors: { label: string; effect: 'raises' | 'lowers'; count: number }[];
  newestDataAt: string | null;
  note: string;
}

const LABEL: Record<string, string> = {
  incident: 'Reported incidents nearby',
  lighting: 'Street lighting nearby',
  activity: 'Public activity nearby',
  support_point: 'Police, hospitals or help desks nearby',
};

export function decay(sourceTime: string | null, asOf: Date, halfLifeDays: number): number {
  if (!sourceTime) return 1; // undated records count in full
  const days = Math.max(0, (asOf.getTime() - new Date(sourceTime).getTime()) / 86_400_000);
  return Math.pow(0.5, days / halfLifeDays);
}

export function scoreRoute(samples: SampleInput[], cfg: ScoringConfig, asOf: Date): RouteScore {
  const near = cfg.radiusM;
  const scale = cfg.scale ?? 25;
  let covered = 0;
  let total = 0;
  const counts = new Map<string, number>();
  let newest: number | null = null;
  for (const s of samples) {
    let raw = 0;
    let any = false;
    for (const p of s.points) {
      any = true;
      if (p.sourceTime) newest = Math.max(newest ?? 0, new Date(p.sourceTime).getTime());
      if (p.distM > near) continue;
      const w = cfg.categoryWeights[p.category] ?? 0;
      raw += w * p.weight * decay(p.sourceTime, asOf, cfg.halfLifeDays);
      counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    }
    if (any) covered += 1;
    total += Math.min(100, Math.max(0, raw) * scale);
  }
  const n = samples.length;
  const coverage = n === 0 ? 0 : covered / n;
  const factors = [...counts.entries()].map(([category, count]) => ({
    label: LABEL[category] ?? category,
    effect: ((cfg.categoryWeights[category] ?? 0) > 0 ? 'raises' : 'lowers') as 'raises' | 'lowers',
    count,
  }));
  const newestDataAt = newest ? new Date(newest).toISOString() : null;
  // Missing data is never counted as safe.
  if (n === 0 || covered < cfg.minCoverage) {
    return { band: 'unknown', riskIndex: null, confidence: 'none', coverage, samples: n, factors, newestDataAt, note: 'There is not enough safety data along this route to give a score.' };
  }
  const risk = Math.round((total / n) * 10) / 10;
  const band = (cfg.bands.find(([min]) => risk >= min)?.[1] ?? 'lower_risk') as Band;
  const confidence = coverage >= 0.6 ? 'high' : coverage >= 0.3 ? 'medium' : 'low';
  return {
    band, riskIndex: risk, confidence, coverage: Math.round(coverage * 100) / 100, samples: n, factors, newestDataAt,
    note: 'Advice only, based on reported data. It does not mean a route is safe or unsafe.',
  };
}

/** Decodes a Google encoded polyline into [lat, lng] points. */
export function decodePolyline(encoded: string): [number, number][] {
  const out: [number, number][] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let result = 0, shift = 0, b: number;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0; shift = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;
export function haversineM(a: [number, number], b: [number, number]): number {
  const dLat = rad(b[0] - a[0]);
  const dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Points along the route roughly every `everyM` metres, at most `max` of them. */
export function sampleRoute(path: [number, number][], everyM: number, max = 60): [number, number][] {
  if (path.length === 0) return [];
  let length = 0;
  for (let i = 1; i < path.length; i++) length += haversineM(path[i - 1], path[i]);
  const step = Math.max(everyM, length / max);
  const out: [number, number][] = [path[0]];
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    acc += haversineM(path[i - 1], path[i]);
    if (acc >= step) {
      out.push(path[i]);
      acc = 0;
    }
  }
  const last = path[path.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}
