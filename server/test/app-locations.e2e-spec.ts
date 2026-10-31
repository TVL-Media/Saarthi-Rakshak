import { randomUUID } from 'node:crypto';
import type { LocationsReply, Sos } from '@sarthi/shared';
import Redis from 'ioredis';
import { liveKeys, type LivePoint } from '../src/app/locations/live-location';
import { activeConnections, validateEnv } from '../src/config/env.schema';
import {
  appUser,
  bearer,
  http,
  resetAppTest,
  startAppTest,
  stopAppTest,
  type AppTestContext,
} from './app-test-support';

let ctx: AppTestContext;
let token: string;
let userId: string;
let sosId: string;

beforeAll(async () => {
  ctx = await startAppTest();
});

beforeEach(async () => {
  await resetAppTest(ctx);
  ({ token, userId } = await appUser(ctx));
  sosId = await startSos(token);
});

afterAll(() => stopAppTest(ctx));

const api = () => http(ctx);
const errorOf = (body: unknown) => (body as { error: string }).error;

async function startSos(t: string): Promise<string> {
  const res = await api()
    .post('/app/sos')
    .set(bearer(t))
    .send({
      id: randomUUID(),
      trigger: 'button',
      isTest: false,
      startedAt: new Date().toISOString(),
    })
    .expect(200);
  return (res.body as Sos).id;
}

function point(secondsAgo: number, extra: Record<string, unknown> = {}) {
  return {
    clientPointId: randomUUID(),
    sosId,
    lat: 28.5706 + secondsAgo / 10_000,
    lng: 77.3272,
    accuracyM: 9,
    batteryPct: 64,
    network: 'mobile',
    recordedAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    ...extra,
  };
}

const send = (points: unknown[], t = token) =>
  api().post('/app/locations').set(bearer(t)).send({ points });

describe('POST /app/locations', () => {
  it('saves a batch of points for the SOS', async () => {
    const res = await send([point(6), point(3), point(0)]).expect(200);
    expect(res.body).toEqual({ saved: 3, duplicates: 0 });
    const rows = await ctx.db
      .selectFrom('location_points')
      .select(['sos_event_id', 'battery_pct', 'network', 'accuracy_m'])
      .where('client_point_id', 'is not', null)
      .execute();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      sos_event_id: sosId,
      battery_pct: 64,
      network: 'mobile',
      accuracy_m: 9,
    });
  });

  it('saves a point sent twice only once', async () => {
    const p = point(3);
    await send([p]).expect(200);
    const res = await send([p, point(0)]).expect(200);
    expect(res.body as LocationsReply).toEqual({ saved: 1, duplicates: 1 });
    const n = await ctx.db
      .selectFrom('location_points')
      .select('id')
      .where('client_point_id', 'is not', null)
      .execute();
    expect(n).toHaveLength(2);
  });

  it('keeps the newest point in Redis, even when an older one arrives late', async () => {
    const newest = point(0);
    await send([point(10), newest]).expect(200);
    await send([point(20)]).expect(200); // late, older point
    const latest = await ctx.redis.hget(liveKeys.latest('sos', sosId), 'point');
    expect((JSON.parse(latest!) as LivePoint).recordedAt).toBe(newest.recordedAt);
  });

  it('publishes every new point, oldest first, on the SOS channel', async () => {
    const env = validateEnv(process.env);
    const sub = new Redis(activeConnections(env).redisUrl);
    const got: LivePoint[] = [];
    await sub.subscribe(liveKeys.channel('sos', sosId));
    sub.on('message', (_c, m) => got.push(JSON.parse(m) as LivePoint));

    const a = point(6);
    const b = point(0);
    await send([b, a]).expect(200);
    await send([b]).expect(200); // duplicate: not published again
    await new Promise((r) => setTimeout(r, 200));
    sub.disconnect();

    expect(got.map((p) => p.recordedAt)).toEqual([a.recordedAt, b.recordedAt]);
    expect(got[0]).toEqual({
      sosId,
      journeyId: null,
      lat: a.lat,
      lng: a.lng,
      accuracyM: 9,
      batteryPct: 64,
      network: 'mobile',
      recordedAt: a.recordedAt,
    });
  });

  it("refuses points for another user's SOS", async () => {
    const other = await appUser(ctx, '+919812399999');
    const res = await send([point(0)], other.token).expect(404);
    expect(errorOf(res.body)).toBe('not_found');
  });

  it('accepts points for 2 minutes after the SOS ends, then refuses', async () => {
    await api()
      .post(`/app/sos/${sosId}/end`)
      .set(bearer(token))
      .send({ reason: 'safe' })
      .expect(200);
    await send([point(0)]).expect(200);
    await ctx.db
      .updateTable('sos_events')
      .set({ ended_at: new Date(Date.now() - 3 * 60_000) })
      .execute();
    expect(errorOf((await send([point(0)]).expect(409)).body)).toBe('conflict');
  });

  it('refuses a time in the future, a point with no SOS or journey, and bad numbers', async () => {
    await send([point(-120)]).expect(400);
    await send([{ ...point(0), sosId: undefined }]).expect(400);
    await send([point(0, { lat: 91 })]).expect(400);
    await send([point(0, { batteryPct: 101 })]).expect(400);
    await send([]).expect(400);
  });

  it('works for a blocked user (SOS must always work)', async () => {
    await ctx.db.updateTable('users').set({ status: 'blocked' }).execute();
    await send([point(0)]).expect(200);
  });

  it('stays fast with 50 phones sending at once (test database only)', async () => {
    const users: { token: string }[] = [];
    for (let i = 0; i < 50; i++) {
      // Set-up only: clear the per-IP login limit so 50 test logins can run.
      const keys = await ctx.redis.keys('ratelimit:app:login:*');
      if (keys.length > 0) await ctx.redis.del(...keys);
      users.push(await appUser(ctx, `+91981230${String(i).padStart(4, '0')}`));
    }
    const sos = await Promise.all(users.map((u) => startSos(u.token)));
    const startedAt = Date.now();
    await Promise.all(
      users.map((u, i) =>
        api()
          .post('/app/locations')
          .set(bearer(u.token))
          .send({ points: [point(0, { sosId: sos.at(i) })] })
          .expect(200),
      ),
    );
    // 50 phones x 1 point every 3 s is the pilot's busy case; all must finish well inside 3 s.
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });
});

describe('POST /app/heartbeat', () => {
  it("records the time, battery and network, and the phone's last seen", async () => {
    const deviceId = randomUUID();
    await api()
      .put('/app/device')
      .set(bearer(token))
      .send({
        deviceId,
        model: 'Redmi Note 13',
        androidVersion: '14',
        appVersion: '1.0.0',
        pushToken: null,
        permissions: { location: true, notifications: true, sms: true, microphone: true },
        batteryOptimisationOff: true,
      })
      .expect(204);
    await ctx.db
      .updateTable('devices')
      .set({ last_seen_at: new Date(Date.now() - 3600_000) })
      .execute();

    await api()
      .post('/app/heartbeat')
      .set(bearer(token))
      .send({ batteryPct: 40, network: 'wifi', sosId })
      .expect(204);

    const score = await ctx.redis.zscore(liveKeys.heartbeats, userId);
    expect(Date.now() - Number(score)).toBeLessThan(5000);
    expect(await ctx.redis.hgetall(liveKeys.heartbeat(userId))).toMatchObject({
      batteryPct: '40',
      network: 'wifi',
      sosId,
    });
    const device = await ctx.db
      .selectFrom('devices')
      .select('last_seen_at')
      .executeTakeFirstOrThrow();
    expect(Date.now() - device.last_seen_at!.getTime()).toBeLessThan(5000);
  });

  it('works with an empty body', async () => {
    await api().post('/app/heartbeat').set(bearer(token)).send({}).expect(204);
  });

  it("refuses another user's SOS", async () => {
    const other = await appUser(ctx, '+919812399999');
    await api().post('/app/heartbeat').set(bearer(other.token)).send({ sosId }).expect(404);
  });
});
