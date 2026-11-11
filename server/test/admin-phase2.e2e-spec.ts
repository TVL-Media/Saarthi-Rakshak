/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import type { Kysely } from 'kysely';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { lockDetails } from '../src/app/phase2/rakshak';
import { configureApp } from '../src/app-setup';
import { AppModule } from '../src/app.module';
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

/** A reply whose body the tests read freely. */
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
    send: (method: 'post' | 'patch' | 'put', path: string, body: object): Promise<Res> =>
      server()
        [method](path)
        .set('Origin', env.ADMIN_PANEL_ORIGIN)
        .set('Cookie', cookie)
        .send(body)
        .then((r) => r as Res),
  };
}

async function user(phone = '+919812344521') {
  return (
    await db
      .insertInto('users')
      .values({ phone, name: 'Priya' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
}

describe('Admin: community moderation', () => {
  it('lists pending reports, approves with edits, rejects with a reason; writes official posts', async () => {
    const author = await user();
    const id = randomUUID();
    await db
      .insertInto('community_posts')
      .values({
        id,
        author_user_id: author,
        category: 'lighting',
        area: 'Sector 62',
        body: 'Street lights are out near the metro gate.',
      })
      .execute();
    const a = await admin('support_admin');
    const list = await a.get('/admin/community/posts?status=pending');
    expect(list.status).toBe(200);
    expect(list.body.pendingCount).toBe(1);
    expect(list.body.items[0]).toMatchObject({ id, area: 'Sector 62', official: false });
    expect(JSON.stringify(list.body)).not.toContain('98123');

    expect(
      (await a.send('patch', `/admin/community/posts/${id}`, { action: 'reject' })).status,
    ).toBe(400);
    const ok = await a.send('patch', `/admin/community/posts/${id}`, {
      action: 'approve',
      body: 'Street lights are out near the Sector 62 metro gate.',
    });
    expect(ok.status).toBe(200);
    const row = await db
      .selectFrom('community_posts')
      .select(['status', 'body'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      status: 'published',
      body: 'Street lights are out near the Sector 62 metro gate.',
    });

    const off = await a.send('post', '/admin/community/posts', {
      category: 'road',
      area: 'All Noida',
      body: 'Road works on the expressway this week, plan extra time.',
    });
    expect(off.status).toBe(200);
    const audit = await db.selectFrom('audit_log').select('action').execute();
    expect(audit.map((r) => r.action)).toEqual(
      expect.arrayContaining(['PATCH /admin/community/posts/:id']),
    );
  });
});

describe('Admin: Rakshak applications', () => {
  it('Super Admin only; sees details and documents (audit-logged); decides with a reason', async () => {
    const u = await user();
    const app = await db
      .insertInto('rakshak_applications')
      .values({
        user_id: u,
        locked_details: lockDetails(env, {
          fullName: 'Priya Sharma',
          dateOfBirth: '1995-04-12',
          address: 'Sector 62, Noida',
          motivation: 'I want to help.',
        }),
        area: 'Sector 62',
        id_type: 'pan',
        id_last4: 'AB12',
        documents: JSON.stringify({}),
        consent_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const support = await admin('support_admin');
    expect((await support.get('/admin/rakshak/applications')).status).toBe(403);

    const s = await admin('super_admin');
    const list = await s.get('/admin/rakshak/applications');
    expect(list.body.items).toHaveLength(1);
    const detail = await s.get(`/admin/rakshak/applications/${app.id}`);
    expect(detail.body).toMatchObject({
      fullName: 'Priya Sharma',
      idLast4: 'AB12',
      phone: '+91 98•• ••4521',
    });

    expect(
      (
        await s.send('post', `/admin/rakshak/applications/${app.id}/decision`, {
          decision: 'reject',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await s.send('post', `/admin/rakshak/applications/${app.id}/decision`, {
          decision: 'approve',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await s.send('post', `/admin/rakshak/applications/${app.id}/decision`, {
          decision: 'approve',
        })
      ).status,
    ).toBe(400);
    const views = await db
      .selectFrom('audit_log')
      .select('action')
      .where('action', '=', 'GET /admin/rakshak/applications/:id')
      .execute();
    expect(views).toHaveLength(1);
  });
});

describe('Admin: plans, subscriptions and Phase 2 counts', () => {
  it('a plan cannot go on sale without a price and product id; counts never show personal data', async () => {
    const s = await admin('super_admin');
    const plans = await s.get('/admin/plans');
    expect(plans.body.everythingFree).toBe(true);
    expect((await s.send('put', '/admin/plans/silver', { onSale: true })).status).toBe(400);
    const ok = await s.send('put', '/admin/plans/silver', {
      monthlyPriceInr: 99,
      monthlyProductId: 'silver_monthly',
      onSale: true,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.everythingFree).toBe(false);
    expect((await s.get('/admin/subscriptions')).body.items).toEqual([]);

    const u = await user();
    await db.insertInto('daily_tracking_settings').values({ user_id: u, enabled: true }).execute();
    await db.updateTable('users').set({ consent_at: new Date() }).execute();
    const stats = await s.get('/admin/phase2/stats?days=30');
    expect(stats.body).toMatchObject({
      users: 1,
      fullDayLocationUsers: 1,
      fullDayLocationRate: 100,
      vaultUsers: 0,
    });

    const support = await admin('support_admin');
    expect((await support.get('/admin/plans')).status).toBe(403);
    expect((await support.get('/admin/phase2/stats')).status).toBe(200);
  });
});
