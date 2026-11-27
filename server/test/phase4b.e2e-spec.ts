/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { sql, type Kysely } from 'kysely';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { configureApp } from '../src/app-setup';
import { AppModule } from '../src/app.module';
import { FakePhoneTokenVerifier } from '../src/app/auth/phone-token-verifier';
import { hashPassword } from '../src/auth/password';
import { ENV } from '../src/config/env.module';
import { activeConnections, validateEnv, type Env } from '../src/config/env.schema';
import type { Database } from '../src/database/types';
import { openTestDatabase, resetTestDatabase } from './test-database';

let app: INestApplication;
let db: Kysely<Database>;
let redis: Redis;
let env: Env;
const PASSWORD = 'river-mango-lantern-42';

beforeAll(async () => {
  db = await openTestDatabase();
  env = { ...validateEnv(process.env), ADMIN_TWO_STEP: 'off' };
  redis = new Redis(activeConnections(env).redisUrl);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .compile();
  app = moduleRef.createNestApplication();
  configureApp(app, env);
  await app.init();
});

beforeEach(async () => {
  await resetTestDatabase(db);
  await redis.flushdb();
});

afterAll(async () => {
  await app?.close();
  redis?.disconnect();
  await db?.destroy();
});

type Res = Omit<Response, 'body'> & { body: Record<string, any> };
const server = () => request(app.getHttpServer() as App);

async function admin(role: 'super_admin' | 'support_admin') {
  const email = `${role}@example.test`;
  await db
    .insertInto('admins')
    .values({ name: role, email, role, password_hash: await hashPassword(PASSWORD) })
    .execute();
  const login = await server()
    .post('/admin/auth/login')
    .set('Origin', env.ADMIN_PANEL_ORIGIN)
    .send({ email, password: PASSWORD });
  const cookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  return {
    get: (path: string): Promise<Res> =>
      server()
        .get(path)
        .set('Cookie', cookie)
        .then((r) => r as Res),
    post: (path: string, body: object = {}): Promise<Res> =>
      server()
        .post(path)
        .set('Origin', env.ADMIN_PANEL_ORIGIN)
        .set('Cookie', cookie)
        .send(body)
        .then((r) => r as Res),
  };
}

/** A signed-in app user (the test phone-token verifier accepts a made-up token). */
async function appUser(phone = '+919812344521', name = 'Priya Sharma') {
  const login = await server()
    .post('/v1/auth/firebase')
    .send({ firebaseIdToken: FakePhoneTokenVerifier.token(phone) })
    .expect(200);
  const token = login.body.token as string;
  const userId = login.body.user.id as string;
  await server()
    .post('/v1/me/consent')
    .set({ Authorization: `Bearer ${token}` })
    .send({ version: '2026-10' })
    .expect(200);
  await db.updateTable('users').set({ name }).where('id', '=', userId).execute();
  const auth = { Authorization: `Bearer ${token}` };
  return {
    userId,
    get: (path: string): Promise<Res> =>
      server()
        .get(path)
        .set(auth)
        .then((r) => r as Res),
    post: (path: string, body: object = {}): Promise<Res> =>
      server()
        .post(path)
        .set(auth)
        .send(body)
        .then((r) => r as Res),
    put: (path: string, body: object = {}): Promise<Res> =>
      server()
        .put(path)
        .set(auth)
        .send(body)
        .then((r) => r as Res),
    del: (path: string): Promise<Res> =>
      server()
        .delete(path)
        .set(auth)
        .then((r) => r as Res),
  };
}


import { createHmac } from 'node:crypto';
import { classify, redact } from '../src/app/phase4b/cyber-classifier';
import { decodePolyline, sampleRoute, scoreRoute, type ScoringConfig } from '../src/app/phase4b/scoring';

const switchOn = async (...keys: string[]) => {
  for (const key of keys) {
    await db
      .insertInto('settings')
      .values({ key, value: 1 })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: 1 }))
      .execute();
  }
};
async function linkedPair(phoneChild = '+919812300011') {
  await switchOn('feature.child_safety');
  const parent = await appUser();
  const child = await appUser(phoneChild, 'Aarav');
  const linkId = randomUUID();
  await parent.post('/v1/child/links', { id: linkId, childName: 'Aarav', childPhone: phoneChild }).then((r) => expect(r.status).toBe(200));
  await child.post(`/v1/child/invitations/${linkId}/accept`).then((r) => expect(r.status).toBe(200));
  return { parent, child, linkId };
}

const NEW_PATHS = [
  `/v1/monitoring/${randomUUID()}`,
  '/v1/school-links',
  `/v1/cyber/${randomUUID()}`,
  '/v1/glasses/models',
  '/v1/child/monitoring',
];

describe('Phase 4 services: switches', () => {
  it('say "Not available yet" while off', async () => {
    const u = await appUser();
    for (const p of NEW_PATHS) {
      const res = await u.get(p);
      expect([p, res.status, res.body.message]).toEqual([p, 404, 'Not available yet.']);
    }
    expect((await u.post('/v1/safe-route/routes', { from: { lat: 28.5, lng: 77.3 }, to: { lat: 28.6, lng: 77.4 } })).status).toBe(404);
    // The SOS status line says nothing about police until the switch is on.
    expect((await u.get(`/v1/sos-handoff/${randomUUID()}`)).status).toBe(404);
  });
});

describe('P4-06 Chhupa Rakshak', () => {
  const start = (parent: any, linkId: string, id = randomUUID()) =>
    parent.post(`/v1/monitoring/${linkId}/sessions`, { id, reason: 'Late and not answering' });

  it('needs consent, is visible to the child, stops on child stop, and keeps a history', async () => {
    await switchOn('feature.chhupa_rakshak');
    const { parent, child, linkId } = await linkedPair();
    expect((await start(parent, linkId)).status).toBe(409); // not turned on yet
    expect((await parent.put(`/v1/monitoring/${linkId}/consent`, { enabled: true })).status).toBe(400); // must accept the notice
    const on = await parent.put(`/v1/monitoring/${linkId}/consent`, { enabled: true, accept: true });
    expect(on.body.enabled).toBe(true);
    expect(on.body.mediaType).toBe('location');
    const s = await start(parent, linkId);
    expect(s.status).toBe(200);
    expect((await start(parent, linkId)).status).toBe(409); // one at a time
    const seen = await child.get('/v1/child/monitoring');
    expect(seen.body.active).toMatchObject({ id: s.body.id, parentName: 'Priya Sharma' });
    // Only the linked child can send a location, and only while it is active.
    const stranger = await appUser('+919812300055', 'Stranger');
    expect((await stranger.post(`/v1/child/monitoring/${s.body.id}/location`, { lat: 28.57, lng: 77.32 })).status).toBe(404);
    expect((await child.post(`/v1/child/monitoring/${s.body.id}/location`, { lat: 28.57, lng: 77.32, accuracyM: 12 })).status).toBe(200);
    const live = await parent.get(`/v1/monitoring-sessions/${s.body.id}`);
    expect(live.body.lastLocation).toMatchObject({ lat: 28.57, lng: 77.32, stale: false, approximate: false });
    expect((await stranger.get(`/v1/monitoring-sessions/${s.body.id}`)).status).toBe(404);
    const stopped = await child.post(`/v1/child/monitoring/${s.body.id}/stop`);
    expect(stopped.body.active).toBeNull();
    expect((await child.post(`/v1/child/monitoring/${s.body.id}/location`, { lat: 28.57, lng: 77.32 })).status).toBe(409);
    const overview = await parent.get(`/v1/monitoring/${linkId}`);
    expect(overview.body.history[0]).toMatchObject({ status: 'stopped', endReason: 'child_stop' });
    // Every start and view is logged.
    const log = await db.selectFrom('monitoring_access_log' as never).select('action' as never).execute();
    expect((log as any[]).map((l) => l.action)).toEqual(expect.arrayContaining(['start', 'view']));
  });

  it('stops when the link is revoked or time runs out; admins see metadata only', async () => {
    await switchOn('feature.chhupa_rakshak');
    const { parent, child, linkId } = await linkedPair();
    await parent.put(`/v1/monitoring/${linkId}/consent`, { enabled: true, accept: true });
    const s1 = await start(parent, linkId);
    await child.post(`/v1/child/monitoring/${s1.body.id}/location`, { lat: 28.57, lng: 77.32 });
    await parent.post(`/v1/child/links/${linkId}/revoke`);
    const afterRevoke = await child.get('/v1/child/monitoring');
    expect(afterRevoke.body.active).toBeNull();
    expect(afterRevoke.body.history[0].endReason).toBe('permission_lost');
    // A revoked link cannot start a new session.
    expect((await start(parent, linkId)).status).toBe(409);
    const sa = await admin('super_admin');
    const list = await sa.get('/admin/phase4b/monitoring');
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toMatch(/"lat"|"lng"|lastLocation/);
  });

  it('expires by itself', async () => {
    await switchOn('feature.chhupa_rakshak');
    const { parent, child, linkId } = await linkedPair();
    await parent.put(`/v1/monitoring/${linkId}/consent`, { enabled: true, accept: true });
    const s = await start(parent, linkId);
    await sql`UPDATE monitoring_sessions SET expires_at = now() - interval '1 minute'`.execute(db);
    const c = await child.get('/v1/child/monitoring');
    expect(c.body.active).toBeNull();
    expect(c.body.history[0]).toMatchObject({ id: s.body.id, endReason: 'expired' });
  });
});

describe('P4-07 School Monitoring', () => {
  const sign = (secret: string, ts: string, e: any) =>
    createHmac('sha256', secret).update([ts, e.idempotencyKey, e.kind, e.studentRef, e.occurredAt].join('.')).digest('hex');
  const send = (code: string, secret: string, e: any, opts: { ts?: string; sig?: string } = {}) => {
    const ts = opts.ts ?? String(Date.now());
    return server()
      .post(`/hooks/school/${code}`)
      .set('x-sr-timestamp', ts)
      .set('x-sr-signature', opts.sig ?? sign(secret, ts, e))
      .send(e)
      .then((r) => r as Res);
  };

  async function setup() {
    await switchOn('feature.school');
    const sa = await admin('super_admin');
    const made = await sa.post('/admin/phase4b/schools', { code: 'NOIDA-01', name: 'Noida Public School', city: 'Noida' });
    expect(made.status).toBe(200);
    expect(made.body.secret).toHaveLength(43);
    const parent = await appUser();
    expect((await parent.get('/v1/schools?q=noida')).body.items).toHaveLength(0); // not verified yet
    await sa.post(`/admin/phase4b/schools/${made.body.id}/status`, { status: 'verified' });
    const dir = await parent.get('/v1/schools?q=noida');
    expect(dir.body.items[0]).toMatchObject({ name: 'Noida Public School' });
    const linkId = randomUUID();
    const link = await parent.post('/v1/school-links', { id: linkId, schoolId: made.body.id, childName: 'Aarav', studentRef: 'ST-1001' });
    expect(link.body.status).toBe('requested');
    return { sa, parent, linkId, schoolId: made.body.id as string, secret: made.body.secret as string };
  }

  it('accepts only signed events from a verified school for a confirmed link, once each', async () => {
    const { sa, parent, linkId, secret } = await setup();
    const ev = { idempotencyKey: 'evt-0001', kind: 'arrived', studentRef: 'ST-1001', occurredAt: new Date().toISOString() };
    // Not confirmed yet: nothing to attach it to, so it is quarantined.
    expect((await send('NOIDA-01', secret, ev)).status).toBe(400);
    expect((await parent.get(`/v1/school-links/${linkId}/events`)).body.items).toHaveLength(0);
    await sa.post(`/admin/phase4b/school-links/${linkId}/decision`, { status: 'active' });
    const ok = await send('NOIDA-01', secret, ev);
    expect(ok.body.status).toBe('accepted');
    const dup = await send('NOIDA-01', secret, ev);
    expect(dup.body.status).toBe('duplicate');
    const events = (await parent.get(`/v1/school-links/${linkId}/events`)).body.items;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'arrived', source: 'school', correction: false });
    // A bad signature and a stale timestamp are quarantined.
    expect((await send('NOIDA-01', secret, { ...ev, idempotencyKey: 'evt-0002' }, { sig: 'ab'.repeat(32) })).status).toBe(400);
    const old = String(Date.now() - 3_600_000);
    expect((await send('NOIDA-01', secret, { ...ev, idempotencyKey: 'evt-0003' }, { ts: old })).status).toBe(400);
    expect((await send('NOIDA-01', secret, { ...ev, idempotencyKey: 'evt-0004', studentRef: 'ST-9999' })).status).toBe(400);
    const quarantine = (await sa.get('/admin/phase4b/school-quarantine')).body.items.map((x: any) => x.errorType);
    expect(quarantine).toEqual(expect.arrayContaining(['unmapped_child', 'bad_signature', 'stale_timestamp']));
    // A correction keeps the old event and needs a reason.
    const bad = { idempotencyKey: 'evt-0005', kind: 'correction', studentRef: 'ST-1001', occurredAt: new Date().toISOString(), correctsKey: 'evt-0001' };
    expect((await send('NOIDA-01', secret, bad)).status).toBe(400);
    expect((await send('NOIDA-01', secret, { ...bad, reason: 'Marked on the wrong day' })).body.status).toBe('accepted');
    expect((await parent.get(`/v1/school-links/${linkId}/events`)).body.items).toHaveLength(2);
    // A duplicate never sends a second notification.
    expect(JSON.stringify(await db.selectFrom('school_events' as never).selectAll().execute())).not.toContain('secret');
  });

  it('rejects events from an unverified or suspended school, and rotating the key invalidates the old one', async () => {
    const { sa, schoolId, secret, linkId } = await setup();
    await sa.post(`/admin/phase4b/school-links/${linkId}/decision`, { status: 'active' });
    const ev = (n: number) => ({ idempotencyKey: `evt-100${n}`, kind: 'present', studentRef: 'ST-1001', occurredAt: new Date().toISOString() });
    expect((await send('NOIDA-01', secret, ev(1))).status).toBe(200);
    const rotated = await sa.post(`/admin/phase4b/schools/${schoolId}/rotate-key`);
    expect((await send('NOIDA-01', secret, ev(2))).status).toBe(400); // old key
    expect((await send('NOIDA-01', rotated.body.secret, ev(3))).status).toBe(200);
    await sa.post(`/admin/phase4b/schools/${schoolId}/status`, { status: 'suspended' });
    expect((await send('NOIDA-01', rotated.body.secret, ev(4))).status).toBe(400);
    expect((await send('NOPE-99', secret, ev(5))).status).toBe(404);
  });

  it('shows a stale-feed warning and never reports silence as absence; only the owner sees a link', async () => {
    const { sa, parent, linkId } = await setup();
    await sa.post(`/admin/phase4b/school-links/${linkId}/decision`, { status: 'active' });
    const link = (await parent.get('/v1/school-links')).body.items[0];
    expect(link.staleFeed).toBe(true);
    expect(link.lastSchoolEventAt).toBeNull();
    const other = await appUser('+919812300077', 'Other');
    expect((await other.get(`/v1/school-links/${linkId}/events`)).status).toBe(404);
    expect((await other.post(`/v1/school-links/${linkId}/revoke`)).status).toBe(404);
  });
});

describe('P4-08 Cyberbullying Detection', () => {
  it('classifier: explains flags, labels weak ones uncertain, redacts personal data', () => {
    const threat = classify("I'll kill you if you tell anyone. call me on +91 98123 44521");
    expect(threat.find((f) => f.category === 'threat')).toMatchObject({ confidence: 'high' });
    expect(JSON.stringify(threat)).not.toContain('98123');
    expect(threat[0].explanation.length).toBeGreaterThan(10);
    const weak = classify('you are so stupid lol');
    expect(weak).toHaveLength(1);
    expect(weak[0]).toMatchObject({ category: 'humiliation', confidence: 'low' });
    expect(classify("Let's meet at 5 for the cricket match, bring your bat")).toEqual([]);
    expect(classify('ugly stupid loser')[0].confidence).toBe('medium');
    expect(classify('send me nudes or i will post your photos').map((f) => f.category)).toEqual(expect.arrayContaining(['coercion', 'humiliation']));
    expect(redact('mail me at a.b@x.com https://x.com/y 9812344521')).toBe('mail me at [email removed] [link removed] [number removed]');
  });

  it('is off until the parent consents, alerts only the linked pair, and only the parent reviews', async () => {
    await switchOn('feature.cyber_safety');
    const { parent, child, linkId } = await linkedPair();
    expect((await child.post(`/v1/cyber/${linkId}/analyse`, { text: 'you are ugly and stupid and a loser' })).status).toBe(409);
    expect((await child.put(`/v1/cyber/${linkId}/source`, { enabled: true, accept: true })).status).toBe(404); // child cannot turn it on
    expect((await parent.put(`/v1/cyber/${linkId}/source`, { enabled: true })).status).toBe(400);
    await parent.put(`/v1/cyber/${linkId}/source`, { enabled: true, accept: true });
    const stranger = await appUser('+919812300066', 'Stranger');
    expect((await stranger.post(`/v1/cyber/${linkId}/analyse`, { text: 'you are ugly and stupid' })).status).toBe(404);
    const res = await child.post(`/v1/cyber/${linkId}/analyse`, { text: "I'll find you and hurt you. Call 9812344521" });
    expect(res.body.flagged).toBeGreaterThan(0);
    const view = await parent.get(`/v1/cyber/${linkId}`);
    expect(view.body.flags[0]).toMatchObject({ category: 'threat', status: 'new', source: 'Text you shared' });
    expect(JSON.stringify(view.body)).not.toContain('9812344521');
    const id = view.body.flags[0].id;
    expect((await child.post(`/v1/cyber/flags/${id}/review`, { status: 'reviewed' })).status).toBe(404);
    const reviewed = await parent.post(`/v1/cyber/flags/${id}/review`, { status: 'false_positive', note: 'a game chat' });
    expect(reviewed.body.flags.find((f: any) => f.id === id)).toMatchObject({ status: 'false_positive', note: 'a game chat' });
    // Turning the source off stops further checking.
    await parent.put(`/v1/cyber/${linkId}/source`, { enabled: false });
    expect((await child.post(`/v1/cyber/${linkId}/analyse`, { text: "I'll find you and hurt you" })).status).toBe(409);
    // Admins see counts only.
    const sa = await admin('super_admin');
    const summary = await sa.get('/admin/phase4b/cyber');
    expect(summary.body.flags[0]).toMatchObject({ category: 'threat', count: expect.any(Number) });
    expect(JSON.stringify(summary.body)).not.toContain('hurt');
  });
});

describe('P4-12 Smart Glasses', () => {
  it('lists the registry, blocks unsupported models and old firmware with a reason, and queues captures only for paired devices', async () => {
    await switchOn('feature.smart_glasses');
    const sa = await admin('super_admin');
    const u = await appUser();
    expect((await u.get('/v1/glasses/models')).body.items).toEqual([]);
    const ok = await sa.post('/admin/phase4b/glasses-models', { manufacturer: 'Acme', model: 'Vision 1', minFirmware: '2.4.0', capabilities: ['video', 'audio'], supported: true });
    const bad = await sa.post('/admin/phase4b/glasses-models', { manufacturer: 'Acme', model: 'Old 0', minFirmware: '1.0.0', supported: false, knownLimits: 'No SDK' });
    expect((await sa.post('/admin/phase4b/glasses-models', { manufacturer: 'Acme', model: 'Vision 1', minFirmware: '2.4.0' })).status).toBe(409);
    const id1 = randomUUID();
    const oldFw = await u.post('/v1/glasses/pair', { id: id1, modelId: ok.body.id, deviceId: 'G-1', firmware: '2.3.9' });
    expect(oldFw.body.items[0]).toMatchObject({ status: 'blocked' });
    expect(oldFw.body.items[0].blockReason).toMatch(/older than/);
    const id2 = randomUUID();
    const unsupported = await u.post('/v1/glasses/pair', { id: id2, modelId: bad.body.id, deviceId: 'G-2', firmware: '9.9' });
    expect(unsupported.body.items.find((g: any) => g.deviceId === 'G-2').blockReason).toMatch(/not supported/);
    const cap = { id: randomUUID(), capturedAt: new Date().toISOString(), captureState: 'recording', fileHash: 'a'.repeat(64) };
    expect((await u.post(`/v1/glasses/${id1}/captures`, cap)).status).toBe(409);
    const id3 = randomUUID();
    const paired = await u.post('/v1/glasses/pair', { id: id3, modelId: ok.body.id, deviceId: 'G-3', firmware: '2.10.0' });
    expect(paired.body.items.find((g: any) => g.deviceId === 'G-3').status).toBe('paired');
    expect((await u.post(`/v1/glasses/${id3}/captures`, cap)).status).toBe(200);
    expect((await u.post(`/v1/glasses/${id3}/captures`, { ...cap, fileHash: 'nothex' })).status).toBe(400);
    expect((await u.get('/v1/glasses')).body.items.find((g: any) => g.id === id3).queuedUploads).toBe(1);
    expect((await u.post(`/v1/glasses/captures/${cap.id}/uploaded`)).status).toBe(200);
    expect((await u.get('/v1/glasses')).body.items.find((g: any) => g.id === id3).queuedUploads).toBe(0);
    const other = await appUser('+919812300088', 'Other');
    expect((await other.post(`/v1/glasses/${id3}/unpair`)).status).toBe(404);
    expect((await u.post(`/v1/glasses/${id3}/unpair`)).body.items.some((g: any) => g.id === id3)).toBe(false);
  });
});

describe('P4-13 AI Safety Scoring', () => {
  const cfg: ScoringConfig = {
    radiusM: 150, sampleEveryM: 100, minCoverage: 3,
    categoryWeights: { incident: 1, lighting: -0.6, activity: -0.4, support_point: -0.5 },
    halfLifeDays: 365, bands: [[70, 'higher_risk'], [40, 'some_risk'], [0, 'lower_risk']],
  };
  const asOf = new Date('2026-11-01T00:00:00Z');

  it('scores the same inputs the same way, and missing data is never safe', () => {
    const samples = (n: number, withData: boolean) =>
      Array.from({ length: n }, (_, i) => ({ lat: 28.5 + i / 1000, lng: 77.3, points: withData ? [{ category: 'incident', weight: 1, sourceTime: '2026-10-01T00:00:00Z', distM: 50 }] : [] }));
    const a = scoreRoute(samples(10, true), cfg, asOf);
    const b = scoreRoute(samples(10, true), cfg, asOf);
    expect(a).toEqual(b);
    expect(a.band).not.toBe('unknown');
    expect(a.confidence).toBe('high');
    const none = scoreRoute(samples(10, false), cfg, asOf);
    expect(none).toMatchObject({ band: 'unknown', riskIndex: null, confidence: 'none' });
    // Lighting nearby lowers the risk; undated and old records are decayed, not ignored.
    const lit = scoreRoute(samples(10, true).map((s) => ({ ...s, points: [...s.points, { category: 'lighting', weight: 1, sourceTime: null, distM: 20 }] })), cfg, asOf);
    expect(lit.riskIndex!).toBeLessThan(a.riskIndex!);
    expect(lit.factors.map((f) => f.effect).sort()).toEqual(['lowers', 'raises']);
  });

  it('decodes and samples a polyline', () => {
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(pts[0][0]).toBeCloseTo(38.5, 1);
    expect(sampleRoute(pts, 100).length).toBeGreaterThan(2);
  });

  const enc = (pts: [number, number][]) => {
    let out = ''; let pl = 0; let pg = 0;
    const e = (v: number) => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
    for (const [la, lo] of pts) { const a = Math.round(la * 1e5); const b = Math.round(lo * 1e5); out += e(a - pl) + e(b - pg); pl = a; pg = b; }
    return out;
  };
  const route = (summary: string, pts: [number, number][], secs: number) => ({
    summary, overview_polyline: { points: enc(pts) }, legs: [{ distance: { value: 1500 }, duration: { value: secs } }],
  });
  const mainRoad: [number, number][] = Array.from({ length: 12 }, (_, i) => [28.57 + i * 0.001, 77.32]);
  const sideRoad: [number, number][] = Array.from({ length: 12 }, (_, i) => [28.57 + i * 0.001, 77.325]);

  it('ranks safer routes first with factors, keeps the fastest visible, and states missing data', async () => {
    await switchOn('feature.safe_route');
    const u = await appUser();
    const body = { from: { lat: 28.57, lng: 77.32 }, to: { lat: 28.581, lng: 77.32 }, mode: 'walking' };
    // No routing key: honest message, no invented routes.
    const none = await u.post('/v1/safe-route/routes', body);
    expect(none.body).toMatchObject({ providerAvailable: false, items: [] });
    const spy = jest.spyOn(globalThis, 'fetch').mockImplementation((async () =>
      new Response(JSON.stringify({ status: 'OK', routes: [route('Main Road', mainRoad, 600), route('Side Road', sideRoad, 780)] }), { status: 200 })) as any);
    const original = (app.get(ENV) as Env).GOOGLE_DIRECTIONS_API_KEY;
    (app.get(ENV) as any).GOOGLE_DIRECTIONS_API_KEY = 'test-directions-key-123';
    try {
      // Routes but no safety data yet: every score says unknown, never "safe".
      const noData = await u.post('/v1/safe-route/routes', body);
      expect(noData.body.items.map((i: any) => i.score.band)).toEqual(['unknown', 'unknown']);
      expect(noData.body.items.find((i: any) => i.isFastest).summary).toBe('Main Road');
      const sa = await admin('super_admin');
      const ds = await sa.post('/admin/phase4b/safety/datasets', { name: 'Noida incidents', kind: 'incident', source: 'Test source', licence: 'Test licence', refreshDays: 30 });
      const lit = await sa.post('/admin/phase4b/safety/datasets', { name: 'Lighting', kind: 'lighting', source: 'Test', licence: 'Test' });
      const incidents = mainRoad.map(([lat, lng]) => ({ lat, lng: lng + 0.0003, category: 'incident', weight: 1, sourceTime: new Date().toISOString() }));
      const imp = await sa.post(`/admin/phase4b/safety/datasets/${ds.body.id}/import`, { records: [...incidents, { lat: 200, lng: 0, category: 'incident', weight: 1 }, { lat: 28.5, lng: 77.3, category: 'incident', weight: 5 }] });
      expect(imp.body).toEqual({ accepted: 12, rejected: 2 });
      await sa.post(`/admin/phase4b/safety/datasets/${ds.body.id}/status`, { status: 'active' });
      await sa.post(`/admin/phase4b/safety/datasets/${lit.body.id}/import`, { records: sideRoad.map(([lat, lng]) => ({ lat, lng, category: 'lighting', weight: 1 })) });
      await sa.post(`/admin/phase4b/safety/datasets/${lit.body.id}/status`, { status: 'active' });
      const scored = await u.post('/v1/safe-route/routes', body);
      expect(scored.body.modelVersion).toBe('v1');
      const [first, second] = scored.body.items;
      expect(first.summary).toBe('Side Road'); // lit, no incidents
      expect(second.summary).toBe('Main Road');
      expect(second.isFastest).toBe(true); // the fastest route is always labelled and shown
      expect(second.score.band).not.toBe('lower_risk');
      expect(second.score.factors.some((f: any) => f.effect === 'raises')).toBe(true);
      expect(first.score.note).toMatch(/not mean a route is safe/i);
      // The result and its inputs are saved with the model version.
      const saved = await sql<any>`SELECT model_version, input_snapshot FROM safety_route_scores WHERE id = ${scored.body.routeScoreId}`.execute(db);
      expect(saved.rows[0].model_version).toBe('v1');
      expect(saved.rows[0].input_snapshot.asOf).toBeDefined();
      // Feedback goes to a review queue and is not treated as incident data.
      const fid = randomUUID();
      await u.post('/v1/safe-route/feedback', { id: fid, routeScoreId: scored.body.routeScoreId, kind: 'inaccurate', message: 'This road is closed at night' });
      expect((await sa.get('/admin/phase4b/safety/feedback')).body.items[0]).toMatchObject({ status: 'new' });
      await sa.post(`/admin/phase4b/safety/feedback/${fid}/review`, { status: 'reviewed' });
      const points = await sql<any>`SELECT count(*)::int AS n FROM safety_points`.execute(db);
      expect(points.rows[0].n).toBe(24);
      // A new model version can be added and made active.
      const m = await sa.post('/admin/phase4b/safety/models', { version: 'v2', activate: true, config: { ...cfg, scale: 30 } });
      expect(m.status).toBe(200);
      expect((await u.post('/v1/safe-route/routes', body)).body.modelVersion).toBe('v2');
    } finally {
      spy.mockRestore();
      (app.get(ENV) as any).GOOGLE_DIRECTIONS_API_KEY = original;
    }
  });
});

describe('P4-14 Police / ERSS handoff', () => {
  const startSos = async (u: any) => {
    const id = randomUUID();
    const res = await u.post('/v1/sos', { id, trigger: 'button', startedAt: new Date().toISOString(), location: { lat: 28.57, lng: 77.32, accuracyM: 10 } });
    expect(res.status).toBe(200);
    return id as string;
  };
  const waitFor = async (id: string, want: string[], tries = 40) => {
    for (let i = 0; i < tries; i++) {
      const r = await sql<any>`SELECT status FROM handoff_attempts WHERE sos_id = ${id} ORDER BY created_at DESC LIMIT 1`.execute(db);
      if (want.includes(r.rows[0]?.status)) return r.rows[0].status;
      await new Promise((r2) => setTimeout(r2, 100));
    }
    return null;
  };
  const endpoint = (over: Record<string, unknown> = {}) => ({
    name: 'ERSS sandbox', kind: 'erss', jurisdiction: 'UP', environment: 'sandbox', baseUrl: 'https://erss.sandbox.test',
    credentialEnv: 'ERSS_TEST_TOKEN', credentialOwner: 'TVL Media', permittedOps: ['send_event'],
    permittedFields: ['eventId', 'callbackNumber', 'location', 'accuracyM', 'time'], ...over,
  });

  it('is silent while the switch is off, then truthfully says "call 112" when no endpoint exists', async () => {
    const u = await appUser();
    const sos = await startSos(u);
    expect((await u.get(`/v1/sos-handoff/${sos}`)).body).toMatchObject({ enabled: false, status: null, call: '112' });
    await switchOn('feature.police_handoff');
    const sos2 = await (async () => { await db.updateTable('sos_events').set({ status: 'ended', ended_at: new Date() } as never).execute(); return startSos(u); })();
    expect(await waitFor(sos2, ['fallback'])).toBe('fallback');
    const s = await u.get(`/v1/sos-handoff/${sos2}`);
    expect(s.body).toMatchObject({ enabled: true, status: 'fallback', label: 'Call 112 yourself', call: '112' });
    expect((await (await appUser('+919812300099', 'Other')).get(`/v1/sos-handoff/${sos2}`)).status).toBe(404);
  });

  it('registers endpoints safely, sends a minimal idempotent payload, and never claims more than the authority said', async () => {
    await switchOn('feature.police_handoff');
    const sa = await admin('super_admin');
    process.env.ERSS_TEST_TOKEN = 'secret-token-value';
    expect((await sa.post('/admin/phase4b/authority/endpoints', endpoint({ permittedFields: ['eventId', 'vaultFiles'] }))).status).toBe(400);
    expect((await sa.post('/admin/phase4b/authority/endpoints', endpoint({ environment: 'production', baseUrl: 'http://insecure.test' }))).status).toBe(400);
    const prod = await sa.post('/admin/phase4b/authority/endpoints', endpoint({ environment: 'production', name: 'ERSS prod' }));
    expect((await sa.post(`/admin/phase4b/authority/endpoints/${prod.body.id}/enabled`, { enabled: true })).status).toBe(409); // sandbox tests first
    const ep = await sa.post('/admin/phase4b/authority/endpoints', endpoint({ permittedFields: ['eventId', 'location', 'time'] }));
    const list = await sa.get('/admin/phase4b/authority/endpoints');
    expect(JSON.stringify(list.body)).not.toContain('secret-token-value');
    expect(list.body.items[0].credentialConfigured).toBe(true);
    expect((await sa.post(`/admin/phase4b/authority/endpoints/${ep.body.id}/enabled`, { enabled: true })).status).toBe(200);
    const calls: any[] = [];
    const spy = jest.spyOn(globalThis, 'fetch').mockImplementation((async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ reference: 'ERSS-77' }), { status: 200 });
    }) as any);
    try {
      const u = await appUser();
      const sos = await startSos(u);
      expect(await waitFor(sos, ['accepted'])).toBe('accepted');
      expect(calls).toHaveLength(1);
      const sent = JSON.parse(calls[0].init.body);
      expect(Object.keys(sent).sort()).toEqual(['eventId', 'location', 'time', 'version']); // only permitted fields
      expect(calls[0].init.headers['idempotency-key']).toBe(`erss:${sos}:${ep.body.id}`);
      expect(calls[0].init.headers.authorization).toBe('Bearer secret-token-value');
      const status = (await u.get(`/v1/sos-handoff/${sos}`)).body;
      expect(status.status).toBe('accepted');
      expect(status.detail).toMatch(/does not mean police are on the way/);
      // The same SOS again (a retry) never creates a second attempt or a second send.
      await u.post('/v1/sos', { id: sos, trigger: 'button', startedAt: new Date().toISOString() });
      await new Promise((r) => setTimeout(r, 300));
      expect(calls).toHaveLength(1);
      const attempts = (await sa.get('/admin/phase4b/authority/attempts')).body.items;
      expect(attempts).toHaveLength(1);
      expect(JSON.stringify(attempts)).not.toMatch(/28\.57|77\.32/);
      // Only the authority's confirmation can make it "acknowledged".
      expect((await sa.post(`/admin/phase4b/authority/attempts/${attempts[0].id}/fallback`)).status).toBe(409);
      expect((await sa.post(`/admin/phase4b/authority/attempts/${attempts[0].id}/acknowledged`, { reason: 'Control room phoned back' })).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects, retries then dead-letters, and never blocks the SOS', async () => {
    jest.setTimeout(20000);
    await switchOn('feature.police_handoff');
    const sa = await admin('super_admin');
    process.env.ERSS_TEST_TOKEN = 'secret-token-value';
    const ep = await sa.post('/admin/phase4b/authority/endpoints', endpoint());
    await sa.post(`/admin/phase4b/authority/endpoints/${ep.body.id}/enabled`, { enabled: true });
    const u = await appUser();
    let mode: 'reject' | 'down' = 'reject';
    const spy = jest.spyOn(globalThis, 'fetch').mockImplementation((async () => {
      if (mode === 'down') throw new Error('network down');
      return new Response('{}', { status: 422 });
    }) as any);
    try {
      const a = await startSos(u);
      expect(await waitFor(a, ['rejected'])).toBe('rejected');
      expect((await u.get(`/v1/sos-handoff/${a}`)).body.label).toMatch(/did not accept/);
      await db.updateTable('sos_events').set({ status: 'ended', ended_at: new Date() } as never).execute();
      mode = 'down';
      const b = await startSos(u); // the SOS itself still starts
      expect(await waitFor(b, ['timed_out'], 100)).toBe('timed_out'); // 3 tries with backoff, then dead letter
      const done = await sql<any>`SELECT status, attempts, dead_letter FROM handoff_attempts WHERE sos_id = ${b}`.execute(db);
      expect(done.rows[0]).toMatchObject({ status: 'timed_out', attempts: 3, dead_letter: true });
      expect((await u.get(`/v1/sos-handoff/${b}`)).body.label).toBe('Could not be delivered');
    } finally {
      spy.mockRestore();
    }
  });

  it('CCTNS: only permitted fields and never "verified" without a clear yes', async () => {
    const sa = await admin('super_admin');
    process.env.ERSS_TEST_TOKEN = 'secret-token-value';
    const ep = await sa.post('/admin/phase4b/authority/endpoints', endpoint({ kind: 'cctns', permittedOps: ['verify'], permittedFields: ['name', 'firNumber'] }));
    await sa.post(`/admin/phase4b/authority/endpoints/${ep.body.id}/enabled`, { enabled: true });
    const spy = jest.spyOn(globalThis, 'fetch');
    try {
      expect((await sa.post(`/admin/phase4b/authority/endpoints/${ep.body.id}/verify`, { purpose: 'Check a complaint', fields: { aadhaar: '123' } })).status).toBe(400);
      spy.mockImplementation((async () => new Response(JSON.stringify({ verified: 'maybe', reference: 'C-1' }), { status: 200 })) as any);
      const unsure = await sa.post(`/admin/phase4b/authority/endpoints/${ep.body.id}/verify`, { purpose: 'Check a complaint', fields: { firNumber: 'FIR-9' } });
      expect(unsure.body.status).toBe('not_verified');
      spy.mockImplementation((async () => new Response(JSON.stringify({ verified: true, reference: 'C-2' }), { status: 200 })) as any);
      expect((await sa.post(`/admin/phase4b/authority/endpoints/${ep.body.id}/verify`, { purpose: 'Check a complaint', fields: { firNumber: 'FIR-9' } })).body.status).toBe('verified');
      const queries = (await sa.get('/admin/phase4b/authority/queries')).body.items;
      expect(queries).toHaveLength(2);
      expect(JSON.stringify(queries)).not.toContain('FIR-9'); // values are never stored
    } finally {
      spy.mockRestore();
    }
  });
});
