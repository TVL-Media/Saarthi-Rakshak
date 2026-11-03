import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { sql, type Kysely } from 'kysely';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { MAX_SMS_ATTEMPTS } from '../src/alerts/alerts.constants';
import { configureApp } from '../src/app-setup';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { ENV } from '../src/config/env.module';
import { activeConnections, validateEnv, type Env } from '../src/config/env.schema';
import type { DashboardSummary } from '../src/dashboard/dashboard.service';
import type { Database } from '../src/database/types';
import { openTestDatabase, resetTestDatabase } from './test-database';

// Dashboard API. Temporary records exist only in the test database.
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
const summary = async (c: Client) => (await c.get('/admin/dashboard')).body as DashboardSummary;

async function user(phone: string, complete = false) {
  const id = (
    await db
      .insertInto('users')
      .values({ phone, name: 'Priya', created_at: ago(30) })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  if (complete) {
    await db
      .insertInto('devices')
      .values({
        user_id: id,
        permissions: { location: true, notifications: true, sms: true, microphone: true },
        battery_optimisation_off: true,
      })
      .execute();
    await db
      .insertInto('guardians')
      .values({ user_id: id, name: 'G', phone: '+919800000009', invite_status: 'accepted' })
      .execute();
  }
  return id;
}

describe('Dashboard', () => {
  it('with nothing yet: zeros, real health, nothing needs attention, no events', async () => {
    const body = await summary(await support());
    expect(body.counts).toEqual({
      activeSos: 0,
      activeJourneys: 0,
      sosToday: 0,
      newUsersToday: 0,
      failedAlertsToday: 0,
    });
    expect(body.health).toEqual({
      server: 'working',
      database: 'working',
      redis: 'working',
      push: 'not_set_up',
      smsMain: 'not_set_up',
      smsBackup: 'not_set_up',
    });
    expect(body.attention).toEqual([]);
    expect(body.recent).toEqual([]);
  });

  it('counts: active SOS and journeys, real SOS today (not tests), new users today', async () => {
    const u = await user('+919811111111');
    await db
      .insertInto('sos_events')
      .values([
        { id: randomUUID(), user_id: u, trigger: 'button', started_at: ago(5) },
        {
          id: randomUUID(),
          user_id: u,
          trigger: 'button',
          started_at: ago(4),
          status: 'ended',
          is_test: true,
        },
        {
          id: randomUUID(),
          user_id: u,
          trigger: 'button',
          started_at: new Date(Date.now() - 3 * 86_400_000),
          status: 'ended',
        },
      ])
      .execute();
    await db
      .insertInto('journeys')
      .values([{ user_id: u }, { user_id: u, status: 'arrived' }])
      .execute();
    const body = await summary(await support());
    expect(body.counts).toMatchObject({
      activeSos: 1,
      activeJourneys: 1,
      sosToday: 1,
      newUsersToday: 1,
    });
  });

  it('needs attention, most urgent first, with one line for unfinished setup', async () => {
    const u = await user('+919811111111');
    await user('+919822222222', true); // setup complete: not counted
    const g = (
      await db
        .insertInto('guardians')
        .values({ user_id: u, name: 'G', phone: '+919800000001', invite_status: 'accepted' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    // Active SOS, nobody responding, last location 20 min ago (lost contact rule: 5 min).
    const sos = randomUUID();
    await db
      .insertInto('sos_events')
      .values({ id: sos, user_id: u, trigger: 'button', started_at: ago(30) })
      .execute();
    await db
      .insertInto('location_points')
      .values({
        user_id: u,
        sos_event_id: sos,
        location: sql<string>`ST_MakePoint(77.3, 28.5)::geography`,
        recorded_at: ago(20),
      })
      .execute();
    const j1 = (
      await db
        .insertInto('journeys')
        .values({ user_id: u, status: 'ended' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('checkins')
      .values({ journey_id: j1, reason: 'stopped', status: 'no_reply', asked_at: ago(60) })
      .execute();
    await db
      .insertInto('alerts')
      .values({
        sos_event_id: sos,
        type: 'sos',
        guardian_id: g,
        channel: 'sms',
        provider: 'backup',
        status: 'failed',
        attempt: MAX_SMS_ATTEMPTS,
        created_at: ago(25),
      })
      .execute();
    const j2 = (
      await db
        .insertInto('journeys')
        .values({ user_id: u, status: 'lost_contact', ended_at: ago(90) })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    // Older than 24 hours: not shown.
    await db
      .insertInto('checkins')
      .values({
        journey_id: j1,
        reason: 'late',
        status: 'no_reply',
        asked_at: new Date(Date.now() - 2 * 86_400_000),
      })
      .execute();

    const body = await summary(await support());
    expect(body.attention.map((a) => a.kind)).toEqual([
      'sos_no_response',
      'sos_lost_contact',
      'checkin_no_reply',
      'sms_all_failed',
      'journey_lost_contact',
      'setup_unfinished',
    ]);
    expect(body.attention[0]).toMatchObject({ sosId: sos });
    expect(body.attention[2]).toMatchObject({ journeyId: j1 });
    expect(body.attention[4]).toMatchObject({ journeyId: j2 });
    expect(body.attention[5]).toEqual({ kind: 'setup_unfinished', count: 1 });
  });

  it('an SOS where a guardian is responding and the phone is reporting is not listed', async () => {
    const u = await user('+919811111111', true);
    const g = (
      await db
        .selectFrom('guardians')
        .select('id')
        .where('user_id', '=', u)
        .executeTakeFirstOrThrow()
    ).id;
    const sos = randomUUID();
    await db
      .insertInto('sos_events')
      .values({ id: sos, user_id: u, trigger: 'button', started_at: ago(3) })
      .execute();
    await db
      .insertInto('guardian_links')
      .values({
        sos_event_id: sos,
        guardian_id: g,
        token_hash: randomUUID(),
        expires_at: ago(-60),
        responding_at: ago(1),
      })
      .execute();
    await db
      .insertInto('location_points')
      .values({
        user_id: u,
        sos_event_id: sos,
        location: sql<string>`ST_MakePoint(77.3, 28.5)::geography`,
        recorded_at: ago(0.5),
      })
      .execute();
    expect((await summary(await support())).attention).toEqual([]);
  });

  it('recent events: no names or phone numbers; SOS lines carry the SOS id; tests left out', async () => {
    const u = await user('+919812344521');
    const sos = randomUUID();
    await db
      .insertInto('sos_events')
      .values([
        {
          id: sos,
          user_id: u,
          trigger: 'button',
          started_at: ago(10),
          status: 'ended',
          ended_at: ago(5),
        },
        {
          id: randomUUID(),
          user_id: u,
          trigger: 'button',
          started_at: ago(2),
          status: 'ended',
          is_test: true,
        },
      ])
      .execute();
    await db
      .insertInto('journeys')
      .values({ user_id: u, started_at: ago(20), status: 'arrived', ended_at: ago(15) })
      .execute();
    const body = await summary(await support());
    expect(body.recent.map((e) => [e.kind, e.sosId])).toEqual([
      ['sos_ended', sos],
      ['sos_started', sos],
      ['journey_arrived', null],
      ['journey_started', null],
      ['user_signed_up', null],
    ]);
    expect(JSON.stringify(body)).not.toMatch(/Priya|9812344521/);
  });

  it('opening is logged once; background refreshes are not logged and do not count as activity', async () => {
    const client = await support();
    const before = (
      await db
        .selectFrom('admin_sessions')
        .select('last_seen_at')
        .where('stage', '=', 'full')
        .executeTakeFirstOrThrow()
    ).last_seen_at;
    await db
      .updateTable('admin_sessions')
      .set({ last_seen_at: ago(10) })
      .execute();
    await client.get('/admin/dashboard');
    await client.get('/admin/dashboard');
    const seen = (
      await db
        .selectFrom('admin_sessions')
        .select('last_seen_at')
        .where('stage', '=', 'full')
        .executeTakeFirstOrThrow()
    ).last_seen_at;
    expect(seen.getTime()).toBeLessThan(before.getTime() - 5 * 60_000);
    expect((await client.post('/admin/dashboard/viewed')).status).toBe(204);
    const rows = await db
      .selectFrom('audit_log')
      .select('action')
      .where('action', 'like', '%dashboard%')
      .execute();
    expect(rows.map((r) => r.action)).toEqual(['dashboard.viewed']);
  });
});
