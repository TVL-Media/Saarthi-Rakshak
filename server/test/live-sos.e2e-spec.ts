import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { sql, type Kysely } from 'kysely';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { configureApp } from '../src/app-setup';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { ENV } from '../src/config/env.module';
import { activeConnections, validateEnv, type Env } from '../src/config/env.schema';
import type { Database } from '../src/database/types';
import type { LiveSosDetails, LiveSosRow } from '../src/live/live-sos.service';
import { openTestDatabase, resetTestDatabase } from './test-database';

// Live SOS API. Temporary records exist only in the test database.
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
  await redis.flushdb(); // the test slot only
});

afterAll(async () => {
  await app?.close();
  redis?.disconnect();
  await db?.destroy();
});

class Client {
  constructor(private readonly cookie: string) {}
  get(path: string): Promise<Response> {
    return request(app.getHttpServer() as App)
      .get(path)
      .set('Cookie', this.cookie)
      .then((r) => r);
  }
  post(path: string): Promise<Response> {
    return request(app.getHttpServer() as App)
      .post(path)
      .set('Origin', env.ADMIN_PANEL_ORIGIN)
      .set('Cookie', this.cookie)
      .then((r) => r);
  }
}

async function support(): Promise<Client> {
  await db
    .insertInto('admins')
    .values({
      name: 'Support',
      email: 'support@example.test',
      role: 'support_admin',
      password_hash: await hashPassword(PASSWORD),
    })
    .execute();
  const login = await request(app.getHttpServer() as App)
    .post('/admin/auth/login')
    .set('Origin', env.ADMIN_PANEL_ORIGIN)
    .send({ email: 'support@example.test', password: PASSWORD });
  return new Client((login.headers['set-cookie'] as unknown as string[])[0].split(';')[0]);
}

const ago = (m: number) => new Date(Date.now() - m * 60_000);
const point = sql<string>`ST_MakePoint(77.3123, 28.5678)::geography`;

async function user(phone: string) {
  return (
    await db
      .insertInto('users')
      .values({ phone, name: 'Priya' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
}

async function sos(
  userId: string,
  startedMinutesAgo: number,
  opts: { lastLocationMinutesAgo?: number; isTest?: boolean } = {},
) {
  const id = randomUUID();
  await db
    .insertInto('sos_events')
    .values({
      id,
      user_id: userId,
      trigger: 'button',
      started_at: ago(startedMinutesAgo),
      is_test: opts.isTest ?? false,
    })
    .execute();
  if (opts.lastLocationMinutesAgo !== undefined) {
    await db
      .insertInto('location_points')
      .values({
        user_id: userId,
        sos_event_id: id,
        location: point,
        recorded_at: ago(opts.lastLocationMinutesAgo),
        accuracy_m: 15,
        battery_pct: 42,
        network: '4G',
      })
      .execute();
  }
  return id;
}

async function responding(sosId: string, userId: string) {
  const g = (
    await db
      .insertInto('guardians')
      .values({ user_id: userId, name: 'G', phone: '+919800000003', invite_status: 'accepted' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  await db
    .insertInto('guardian_links')
    .values({
      sos_event_id: sosId,
      guardian_id: g,
      token_hash: randomUUID(),
      expires_at: ago(-60),
      responding_at: ago(1),
    })
    .execute();
}

describe('Live SOS list', () => {
  it('nothing active: empty list', async () => {
    expect((await (await support()).get('/admin/live')).body).toEqual([]);
  });

  it('order: lost contact or nobody responding first, then longest running; TEST last; masked phone, no name', async () => {
    const u1 = await user('+919811111111');
    const u2 = await user('+919822222222');
    const u3 = await user('+919833333333');
    const calm = await sos(u1, 30, { lastLocationMinutesAgo: 0.2 });
    await responding(calm, u1);
    const noOne = await sos(u2, 5, { lastLocationMinutesAgo: 0.2 });
    const lost = await sos(u3, 10, { lastLocationMinutesAgo: 9 });
    await responding(lost, u3);
    const test = await sos(u1, 60, { isTest: true });

    const rows = (await (await support()).get('/admin/live')).body as LiveSosRow[];
    expect(rows.map((r) => r.id)).toEqual([lost, noOne, calm, test]);
    expect(rows[0]).toMatchObject({
      lostContact: true,
      anyoneResponding: true,
      phone: '+91 98•• ••3333',
    });
    expect(rows[1]).toMatchObject({ lostContact: false, anyoneResponding: false });
    expect(JSON.stringify(rows)).not.toMatch(/Priya|9811111111/);
  });

  it('ended SOS are not listed', async () => {
    const u = await user('+919811111111');
    await db
      .insertInto('sos_events')
      .values({
        id: randomUUID(),
        user_id: u,
        trigger: 'button',
        started_at: ago(5),
        status: 'ended',
      })
      .execute();
    expect((await (await support()).get('/admin/live')).body).toEqual([]);
  });
});

describe('Live SOS details', () => {
  it('last location age and accuracy, never coordinates; battery, network; guardians; audio count only', async () => {
    const u = await user('+919812344521');
    const id = await sos(u, 6, { lastLocationMinutesAgo: 2 });
    const g1 = (
      await db
        .insertInto('guardians')
        .values({
          user_id: u,
          name: 'Rohan',
          phone: '+919800000001',
          relation: 'brother',
          invite_status: 'accepted',
          created_at: ago(100),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('guardians')
      .values({
        user_id: u,
        name: 'Meera',
        phone: '+919800000002',
        invite_status: 'accepted',
        created_at: ago(90),
      })
      .execute();
    await db
      .insertInto('alerts')
      .values([
        {
          sos_event_id: id,
          type: 'sos',
          guardian_id: g1,
          channel: 'sms',
          status: 'delivered',
          created_at: ago(5),
        },
        {
          sos_event_id: id,
          type: 'sos',
          guardian_id: g1,
          channel: 'push',
          status: 'delivered',
          created_at: ago(5),
        },
      ])
      .execute();
    await db
      .insertInto('guardian_links')
      .values({
        sos_event_id: id,
        guardian_id: g1,
        token_hash: randomUUID(),
        expires_at: ago(-60),
        opened_at: ago(4),
        responding_at: ago(3),
      })
      .execute();
    await db
      .insertInto('media_clips')
      .values({
        user_id: u,
        sos_event_id: id,
        storage_key: 'audio/1.enc',
        delete_after: ago(-1000),
      })
      .execute();

    const res = await (await support()).get(`/admin/live/${id}`);
    const body = res.body as Extract<LiveSosDetails, { ended: false }>;
    expect(body).toMatchObject({
      ended: false,
      user: { id: u, name: 'Priya', phone: '+91 98•• ••4521' },
      lastLocation: { accuracyM: 15 },
      battery: 42,
      network: '4G',
      lostContact: false,
      audio: { clips: 1 },
    });
    expect(body.guardians).toEqual([
      {
        label: 'Guardian 1 (brother) +91 98•• ••0001',
        sms: 'delivered',
        push: 'sent',
        openedAt: expect.any(String) as unknown,
        respondingAt: expect.any(String) as unknown,
      },
      {
        label: 'Guardian 2 +91 98•• ••0002',
        sms: null,
        push: null,
        openedAt: null,
        respondingAt: null,
      },
    ]);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(
      /77\.31|28\.56|POINT|storage_key|audio\/1\.enc|Rohan|Meera|980000000[12]/,
    );
  });

  it('an SOS that ended shows only how it ended', async () => {
    const u = await user('+919812344521');
    const id = randomUUID();
    await db
      .insertInto('sos_events')
      .values({
        id,
        user_id: u,
        trigger: 'button',
        started_at: ago(10),
        status: 'ended',
        ended_at: ago(1),
      })
      .execute();
    const body = (await (await support()).get(`/admin/live/${id}`)).body as LiveSosDetails;
    expect(body).toEqual({
      ended: true,
      id,
      outcome: 'ended_safe',
      endedAt: expect.any(String) as unknown,
    });
  });

  it('unknown id: 404', async () => {
    expect((await (await support()).get(`/admin/live/${randomUUID()}`)).status).toBe(404);
  });
});

describe('logging and refreshes', () => {
  it('page and each opened SOS are logged; refreshes are not and do not count as activity', async () => {
    const u = await user('+919812344521');
    const id = await sos(u, 3, { lastLocationMinutesAgo: 0.5 });
    const client = await support();
    await db
      .updateTable('admin_sessions')
      .set({ last_seen_at: ago(10) })
      .execute();
    for (let i = 0; i < 3; i++) {
      await client.get('/admin/live');
      await client.get(`/admin/live/${id}`);
    }
    const seen = (
      await db
        .selectFrom('admin_sessions')
        .select('last_seen_at')
        .where('stage', '=', 'full')
        .executeTakeFirstOrThrow()
    ).last_seen_at;
    expect(seen.getTime()).toBeLessThan(Date.now() - 9 * 60_000);

    expect((await client.post('/admin/live/viewed')).status).toBe(204);
    expect((await client.post(`/admin/live/${id}/viewed`)).status).toBe(204);
    const rows = await db
      .selectFrom('audit_log')
      .select(['action', 'target_id'])
      .where('action', 'like', 'live%')
      .orderBy('id')
      .execute();
    expect(rows).toEqual([
      { action: 'live.viewed', target_id: null },
      { action: 'live_sos.viewed', target_id: id },
    ]);
    expect(
      await db
        .selectFrom('audit_log')
        .select('id')
        .where('action', 'like', 'GET /admin/live%')
        .execute(),
    ).toEqual([]);
  });

  it('there is no route that acts on an SOS', async () => {
    const u = await user('+919812344521');
    const id = await sos(u, 3);
    const client = await support();
    for (const path of [`/admin/live/${id}/end`, `/admin/live/${id}/cancel`, `/admin/live/${id}`]) {
      expect((await client.post(path)).status).toBe(404);
    }
  });
});
