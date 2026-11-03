import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import type { Kysely } from 'kysely';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { MAX_SMS_ATTEMPTS } from '../src/alerts/alerts.constants';
import type { AlertCounts, AlertRow } from '../src/alerts/alerts.service';
import { configureApp } from '../src/app-setup';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { ENV } from '../src/config/env.module';
import { activeConnections, validateEnv, type Env } from '../src/config/env.schema';
import type { Database } from '../src/database/types';
import { openTestDatabase, resetTestDatabase } from './test-database';

// Alert Log API. Temporary records exist only in the test database.
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

async function support(): Promise<{ get: (path: string) => Promise<Response> }> {
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
  const cookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
  return {
    get: (path) =>
      request(app.getHttpServer() as App)
        .get(path)
        .set('Cookie', cookie),
  };
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

async function scene() {
  const user = (
    await db
      .insertInto('users')
      .values({ phone: '+919812344521', name: 'Priya' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  const g1 = (
    await db
      .insertInto('guardians')
      .values({
        user_id: user,
        name: 'Rohan',
        phone: '+919800000001',
        relation: 'brother',
        invite_status: 'accepted',
        created_at: minutesAgo(100),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  const g2 = (
    await db
      .insertInto('guardians')
      .values({
        user_id: user,
        name: 'Meera',
        phone: '+919800000002',
        invite_status: 'accepted',
        created_at: minutesAgo(90),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  const sos = randomUUID();
  await db
    .insertInto('sos_events')
    .values({ id: sos, user_id: user, trigger: 'button', started_at: minutesAgo(30) })
    .execute();
  return { user, g1, g2, sos };
}

type Body = { rows: AlertRow[]; more: boolean; counts: AlertCounts | null };
const list = async (client: Awaited<ReturnType<typeof support>>, query = '') =>
  (await client.get(`/admin/alerts${query}`)).body as Body;

describe('Alert Log', () => {
  it('every "next step" case; failures not fixed later come first', async () => {
    const { g1, g2, sos } = await scene();
    const base = { sos_event_id: sos, type: 'sos' as const };
    await db
      .insertInto('alerts')
      .values([
        // Fixed by a later try: the main-provider failure is followed by a backup success.
        {
          ...base,
          guardian_id: g1,
          channel: 'sms',
          provider: 'main',
          status: 'failed',
          attempt: 1,
          created_at: minutesAgo(29),
        },
        {
          ...base,
          guardian_id: g1,
          channel: 'sms',
          provider: 'backup',
          status: 'delivered',
          attempt: 2,
          created_at: minutesAgo(28),
        },
        // Still failing on backup, tries left.
        {
          ...base,
          guardian_id: g2,
          channel: 'sms',
          provider: 'backup',
          status: 'failed',
          attempt: 2,
          created_at: minutesAgo(27),
        },
        // Push failed but an SMS reached that guardian (g1).
        { ...base, guardian_id: g1, channel: 'push', status: 'failed', created_at: minutesAgo(26) },
        // Push "delivered" is shown as "sent".
        {
          ...base,
          guardian_id: g2,
          channel: 'push',
          status: 'delivered',
          created_at: minutesAgo(25),
        },
        {
          ...base,
          guardian_id: g1,
          channel: 'sms',
          provider: 'main',
          status: 'sent',
          created_at: minutesAgo(24),
        },
        {
          ...base,
          guardian_id: g1,
          channel: 'sms',
          provider: 'main',
          status: 'queued',
          created_at: minutesAgo(23),
        },
      ])
      .execute();

    const body = await list(await support());
    const rows = body.rows.map((r) => [r.channel, r.result, r.nextStep, r.stillFailed]);
    expect(rows).toEqual([
      // Still failed first (newest first among them).
      ['push', 'failed', 'sms_sent_too', true],
      ['sms', 'failed', 'retrying', true],
      // Then everything else, newest first.
      ['sms', 'queued', 'sending', false],
      ['sms', 'sent', 'awaiting_report', false],
      ['push', 'sent', 'none', false],
      ['sms', 'delivered', 'none', false],
      ['sms', 'failed', 'sent_again', false],
    ]);
    expect(body.rows.find((r) => r.nextStep === 'retrying')).toMatchObject({
      attempt: 2,
      maxAttempts: MAX_SMS_ATTEMPTS,
    });
  });

  it('main-provider failure → retry with backup; no tries left → all failed; failed push with no SMS', async () => {
    const { g1, g2, sos } = await scene();
    await db
      .insertInto('alerts')
      .values([
        {
          sos_event_id: sos,
          type: 'sos',
          guardian_id: g1,
          channel: 'sms',
          provider: 'main',
          status: 'failed',
          attempt: 1,
        },
        {
          sos_event_id: sos,
          type: 'sos',
          guardian_id: g2,
          channel: 'sms',
          provider: 'backup',
          status: 'failed',
          attempt: MAX_SMS_ATTEMPTS,
          created_at: minutesAgo(1),
        },
        {
          sos_event_id: sos,
          type: 'sos',
          guardian_id: g2,
          channel: 'push',
          status: 'failed',
          created_at: minutesAgo(2),
        },
      ])
      .execute();
    const steps = (await list(await support())).rows
      .map((r) => `${r.channel}:${r.nextStep}`)
      .sort();
    expect(steps).toEqual(['push:no_sms_yet', 'sms:all_failed', 'sms:retry_backup']);
  });

  it('"To" is "Guardian N (relation) masked phone" with SOS or journey; never names or full numbers', async () => {
    const { user, g1, g2, sos } = await scene();
    const journey = (
      await db
        .insertInto('journeys')
        .values({ user_id: user })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('alerts')
      .values([
        {
          sos_event_id: sos,
          type: 'sos',
          guardian_id: g1,
          channel: 'sms',
          status: 'sent',
          created_at: minutesAgo(2),
        },
        {
          journey_id: journey,
          type: 'checkin_no_reply',
          guardian_id: g2,
          channel: 'sms',
          status: 'sent',
          created_at: minutesAgo(1),
        },
      ])
      .execute();
    const body = await list(await support());
    expect(body.rows.map((r) => [r.to, r.about?.type])).toEqual([
      ['Guardian 2 +91 98•• ••0002', 'journey'],
      ['Guardian 1 (brother) +91 98•• ••0001', 'sos'],
    ]);
    expect(JSON.stringify(body)).not.toMatch(/Priya|Rohan|Meera|9812344521|980000000[12]/);
  });

  it('today’s counters (India day): failed counts only failures not fixed later', async () => {
    const { g1, g2, sos } = await scene();
    await db
      .insertInto('alerts')
      .values([
        {
          sos_event_id: sos,
          type: 'sos',
          guardian_id: g1,
          channel: 'sms',
          provider: 'main',
          status: 'failed',
          created_at: minutesAgo(5),
        },
        {
          sos_event_id: sos,
          type: 'sos',
          guardian_id: g1,
          channel: 'sms',
          provider: 'backup',
          status: 'delivered',
          created_at: minutesAgo(4),
        },
        {
          sos_event_id: sos,
          type: 'sos',
          guardian_id: g2,
          channel: 'sms',
          provider: 'backup',
          status: 'failed',
          created_at: minutesAgo(3),
        },
        {
          sos_event_id: sos,
          type: 'sos',
          guardian_id: g2,
          channel: 'push',
          status: 'delivered',
          created_at: minutesAgo(2),
        },
        // Yesterday and earlier: not counted.
        {
          sos_event_id: sos,
          type: 'sos',
          guardian_id: g2,
          channel: 'sms',
          status: 'sent',
          created_at: new Date(Date.now() - 3 * 86_400_000),
        },
      ])
      .execute();
    expect((await list(await support())).counts).toEqual({
      sentToday: 2,
      deliveredToday: 1,
      failedToday: 1,
      backupToday: 1,
    });
  });

  it('with no alerts: zeros and an empty list; pages of 50; read-only and logged', async () => {
    const client = await support();
    expect(await list(client)).toEqual({
      rows: [],
      more: false,
      counts: { sentToday: 0, deliveredToday: 0, failedToday: 0, backupToday: 0 },
    });

    const { g1, sos } = await scene();
    await db
      .insertInto('alerts')
      .values(
        Array.from({ length: 60 }, (_, i) => ({
          sos_event_id: sos,
          type: 'sos' as const,
          guardian_id: g1,
          channel: 'sms' as const,
          status: i % 3 === 0 ? 'failed' : 'sent',
          provider: 'backup' as const,
          attempt: MAX_SMS_ATTEMPTS,
          created_at: minutesAgo(i),
        })),
      )
      .execute();
    const first = await list(client);
    expect(first.rows).toHaveLength(50);
    const second = await list(client, `?before=${encodeURIComponent(first.rows[49].cursor)}`);
    expect(second.counts).toBeNull();
    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(60);

    const views = await db
      .selectFrom('audit_log')
      .select('action')
      .where('action', '=', 'GET /admin/alerts')
      .execute();
    expect(views.length).toBeGreaterThan(0);
    const post = await request(app.getHttpServer() as App)
      .post('/admin/alerts')
      .set('Origin', env.ADMIN_PANEL_ORIGIN);
    expect(post.status).not.toBe(200);
  });
});
