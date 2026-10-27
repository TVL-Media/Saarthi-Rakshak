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
import type { HistoryRow, TimelineEvent } from '../src/history/history.service';
import { openTestDatabase, resetTestDatabase } from './test-database';

// SOS & Journey History API. Temporary records exist only in the test database.
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
  cookie?: string;

  async get(path: string): Promise<Response> {
    let req = request(app.getHttpServer() as App).get(path);
    if (this.cookie) req = req.set('Cookie', this.cookie);
    return req;
  }

  async post(path: string, body: object = {}): Promise<Response> {
    let req = request(app.getHttpServer() as App)
      .post(path)
      .set('Origin', env.ADMIN_PANEL_ORIGIN);
    if (this.cookie) req = req.set('Cookie', this.cookie);
    const res = await req.send(body);
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    if (setCookie) this.cookie = setCookie[0].split(';')[0];
    return res;
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
  const client = new Client();
  await client.post('/admin/auth/login', { email: 'support@example.test', password: PASSWORD });
  return client;
}

const at = (minutes: number) => new Date(Date.UTC(2025, 2, 14, 18, 0) + minutes * 60_000); // 14 Mar 23:30 IST

async function user(phone = '+919812344521', name = 'Priya') {
  return (
    await db.insertInto('users').values({ phone, name }).returning('id').executeTakeFirstOrThrow()
  ).id;
}

async function guardian(userId: string, phone: string, relation: string | null) {
  return (
    await db
      .insertInto('guardians')
      .values({ user_id: userId, name: 'Secret Name', phone, relation, invite_status: 'accepted' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
}

type ListBody = { rows: HistoryRow[]; more: boolean };
const list = async (client: Client, query = '') =>
  (await client.get(`/admin/history${query}`)).body as ListBody;

describe('history list', () => {
  it('SOS rows name the user (masked); journey rows never do; deleted users have no link', async () => {
    const u = await user();
    const sosId = randomUUID();
    await db
      .insertInto('sos_events')
      .values({
        id: sosId,
        user_id: u,
        trigger: 'widget',
        started_at: at(10),
        status: 'ended',
        ended_at: at(20),
      })
      .execute();
    await db
      .insertInto('journeys')
      .values({ user_id: u, started_at: at(0), status: 'arrived', ended_at: at(5) })
      .execute();
    const orphan = randomUUID();
    await db
      .insertInto('sos_events')
      .values({
        id: orphan,
        user_id: null,
        trigger: 'button',
        started_at: at(-10),
        status: 'ended',
      })
      .execute();

    const body = await list(await support());
    expect(body.rows.map((r) => [r.type, r.outcome])).toEqual([
      ['sos', 'ended_safe'],
      ['journey', 'arrived'],
      ['sos', 'ended_safe'],
    ]);
    expect(body.rows[0].user).toEqual({ id: u, name: 'Priya', phone: '+91 98•• ••4521' });
    expect(body.rows[1].user).toBeNull();
    expect(body.rows[2]).toMatchObject({ user: null, userDeleted: true });
    expect(JSON.stringify(body)).not.toContain('9812344521');
  });

  it('outcomes: cancelled, still active, lost contact, turned into SOS (with its SOS id)', async () => {
    const u = await user();
    const cancelled = randomUUID();
    const active = randomUUID();
    await db
      .insertInto('sos_events')
      .values([
        { id: cancelled, user_id: u, trigger: 'button', started_at: at(0), status: 'cancelled' },
        { id: active, user_id: u, trigger: 'button', started_at: at(1) },
      ])
      .execute();
    await db
      .insertInto('journeys')
      .values({ user_id: u, started_at: at(2), status: 'lost_contact' })
      .execute();
    const j = (
      await db
        .insertInto('journeys')
        .values({ user_id: u, started_at: at(3), status: 'ended' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const fromJourney = randomUUID();
    await db
      .insertInto('sos_events')
      .values({
        id: fromJourney,
        user_id: u,
        journey_id: j,
        trigger: 'journey',
        started_at: at(4),
        status: 'ended',
      })
      .execute();

    const rows = (await list(await support())).rows;
    const byOutcome = Object.fromEntries(rows.map((r) => [`${r.type}:${r.outcome}`, r]));
    expect(byOutcome['sos:cancelled'].id).toBe(cancelled);
    expect(byOutcome['sos:active'].id).toBe(active);
    expect(byOutcome['journey:lost_contact']).toBeDefined();
    expect(byOutcome['journey:turned_into_sos']).toMatchObject({ id: j, sosId: fromJourney });
  });

  it('filters: type, real/test, outcome, India dates', async () => {
    const u = await user();
    await db
      .insertInto('sos_events')
      .values([
        {
          id: randomUUID(),
          user_id: u,
          trigger: 'button',
          started_at: at(0),
          status: 'ended',
          is_test: true,
        },
        {
          id: randomUUID(),
          user_id: u,
          trigger: 'button',
          started_at: at(60),
          status: 'cancelled',
        }, // 15 Mar 00:30 IST
      ])
      .execute();
    await db
      .insertInto('journeys')
      .values({ user_id: u, started_at: at(1), status: 'arrived' })
      .execute();
    const client = await support();

    expect((await list(client, '?type=journey')).rows.map((r) => r.type)).toEqual(['journey']);
    expect((await list(client, '?real=test')).rows.map((r) => r.isTest)).toEqual([true]);
    expect((await list(client, '?real=real')).rows.every((r) => !r.isTest)).toBe(true);
    expect((await list(client, '?outcome=cancelled')).rows.map((r) => r.outcome)).toEqual([
      'cancelled',
    ]);
    expect((await list(client, '?from=2025-03-14&to=2025-03-14')).rows).toHaveLength(2);
    expect(
      (await list(client, '?from=2025-03-15&to=2025-03-15')).rows.map((r) => r.outcome),
    ).toEqual(['cancelled']);
  });

  it('pages of 50 with "Load more": no gaps, no duplicates', async () => {
    const u = await user();
    await db
      .insertInto('journeys')
      .values(
        Array.from({ length: 60 }, (_, i) => ({
          user_id: u,
          started_at: at(i % 5),
          status: 'ended' as const,
        })),
      )
      .execute();
    const client = await support();
    const first = await list(client);
    expect(first.rows).toHaveLength(50);
    const second = await list(client, `?before=${encodeURIComponent(first.rows[49].cursor)}`);
    expect(second.more).toBe(false);
    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(60);
  });

  it('is read-only and logged as a view', async () => {
    const client = await support();
    await list(client);
    expect((await client.post('/admin/history')).status).toBe(404);
    const views = await db
      .selectFrom('audit_log')
      .select('action')
      .where('action', '=', 'GET /admin/history')
      .execute();
    expect(views).toHaveLength(1);
  });
});

describe('timeline', () => {
  it('SOS: started, alerts per guardian (numbered, relation, masked), link, responding, gap, ended', async () => {
    const u = await user();
    const g1 = await guardian(u, '+919800000001', 'brother');
    const g2 = await guardian(u, '+919800000002', null);
    const sosId = randomUUID();
    await db
      .insertInto('sos_events')
      .values({
        id: sosId,
        user_id: u,
        trigger: 'button',
        started_at: at(0),
        status: 'ended',
        ended_at: at(20),
      })
      .execute();
    await db
      .insertInto('alerts')
      .values([
        {
          sos_event_id: sosId,
          guardian_id: g1,
          channel: 'sms',
          type: 'sos',
          status: 'delivered',
          sent_at: at(0.1),
          delivered_at: at(0.2),
        },
        {
          sos_event_id: sosId,
          guardian_id: g2,
          channel: 'push',
          type: 'sos',
          status: 'failed',
          sent_at: at(0.1),
        },
      ])
      .execute();
    await db
      .insertInto('guardian_links')
      .values({
        sos_event_id: sosId,
        guardian_id: g1,
        token_hash: randomUUID(),
        expires_at: at(60),
        opened_at: at(1),
        responding_at: at(2),
      })
      .execute();
    const point = sql<string>`ST_MakePoint(77.3, 28.5)::geography`;
    await db
      .insertInto('location_points')
      .values([
        { user_id: u, sos_event_id: sosId, location: point, recorded_at: at(3) },
        { user_id: u, sos_event_id: sosId, location: point, recorded_at: at(3.05) },
        { user_id: u, sos_event_id: sosId, location: point, recorded_at: at(8) }, // 5-minute gap
        { user_id: u, sos_event_id: sosId, location: point, recorded_at: at(9) }, // 1 min: no gap
      ])
      .execute();

    const res = await (await support()).get(`/admin/history/sos/${sosId}`);
    expect(res.status).toBe(200);
    const events = (res.body as { events: TimelineEvent[] }).events;
    expect(events.map((e) => e.text)).toEqual([
      'SOS started (SOS button)',
      'SMS sent to Guardian 1 (brother) +91 98•• ••0001',
      'Push sent to Guardian 2 +91 98•• ••0002',
      'Push to Guardian 2 +91 98•• ••0002 failed',
      'SMS delivered to Guardian 1 (brother) +91 98•• ••0001',
      'Guardian 1 (brother) +91 98•• ••0001 opened the live link',
      'Guardian 1 (brother) +91 98•• ••0001 is responding',
      'No location for 5 min',
      'Ended: user safe',
    ]);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/980000000[12]|Secret Name|77\.3|28\.5|POINT/);
  });

  it('journey: check-ins, no reply, turned into SOS', async () => {
    const u = await user();
    const j = (
      await db
        .insertInto('journeys')
        .values({ user_id: u, started_at: at(0), status: 'ended', ended_at: at(30) })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('checkins')
      .values([
        { journey_id: j, reason: 'stopped', status: 'fine', asked_at: at(5), answered_at: at(6) },
        {
          journey_id: j,
          reason: 'off_route',
          status: 'no_reply',
          asked_at: at(10),
          answered_at: at(12),
        },
      ])
      .execute();
    await db
      .insertInto('sos_events')
      .values({
        id: randomUUID(),
        user_id: u,
        journey_id: j,
        trigger: 'journey',
        started_at: at(15),
        status: 'ended',
      })
      .execute();

    const res = await (await support()).get(`/admin/history/journey/${j}`);
    const body = res.body as { row: HistoryRow; events: TimelineEvent[] };
    expect(body.row).toMatchObject({ user: null, outcome: 'turned_into_sos' });
    expect(body.events.map((e) => e.text)).toEqual([
      'Journey started',
      'Check-in asked (stopped too long)',
      'User replied: I’m fine',
      'Check-in asked (off route)',
      'No reply: guardians alerted',
      'Turned into SOS',
      'Journey ended',
    ]);
  });

  it('unknown id: 404', async () => {
    expect((await (await support()).get(`/admin/history/sos/${randomUUID()}`)).status).toBe(404);
  });
});
