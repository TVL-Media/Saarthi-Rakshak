import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import type { Kysely } from 'kysely';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { configureApp } from '../src/app-setup';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { ENV } from '../src/config/env.module';
import { activeConnections, validateEnv, type Env } from '../src/config/env.schema';
import type { Database } from '../src/database/types';
import { openTestDatabase, resetTestDatabase } from './test-database';

// Users API. Temporary users exist only in the test database. 2-step is off (password only).
let app: INestApplication;
let db: Kysely<Database>;
let redis: Redis;
let env: Env;
const PASSWORD = 'river-mango-lantern-42';
const REASON = 'User asked us on a support call';

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

async function admin(role: 'super_admin' | 'support_admin'): Promise<Client> {
  const email = `${role}@example.test`;
  await db
    .insertInto('admins')
    .values({ name: role, email, role, password_hash: await hashPassword(PASSWORD) })
    .execute();
  const client = new Client();
  expect((await client.post('/admin/auth/login', { email, password: PASSWORD })).status).toBe(200);
  return client;
}

/** A user with a device; complete = all permissions, battery saving off, one accepted guardian. */
async function addUser(phone: string, opts: { name?: string; complete?: boolean } = {}) {
  const user = await db
    .insertInto('users')
    .values({ phone, name: opts.name ?? 'Test User' })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('devices')
    .values({
      user_id: user.id,
      model: 'Redmi Note 12',
      android_version: '14',
      app_version: '1.0.0',
      permissions: opts.complete
        ? { location: true, notifications: true, sms: true, microphone: true }
        : { location: true, notifications: false },
      battery_optimisation_off: Boolean(opts.complete),
      last_seen_at: new Date(),
    })
    .execute();
  await db
    .insertInto('guardians')
    .values({
      user_id: user.id,
      name: 'Maa',
      phone: '+919800000001',
      invite_status: opts.complete ? 'accepted' : 'pending',
    })
    .execute();
  return user.id;
}

type ListBody = {
  users: { id: string; phone: string; setupComplete: boolean; status: string }[];
  more: boolean;
};
const search = async (client: Client, body: object = {}) =>
  (await client.post('/admin/users/search', body)).body as ListBody;

describe('user list and search', () => {
  it('shows masked phones only; full numbers never leave the server', async () => {
    await addUser('+919812344521', { complete: true });
    const support = await admin('support_admin');
    const res = await support.post('/admin/users/search', {});
    expect(res.status).toBe(200);
    expect((res.body as ListBody).users[0].phone).toBe('+91 98•• ••4521');
    expect(JSON.stringify(res.body)).not.toContain('9812344521');
  });

  it('finds a user by the exact full number in any common format, never by part of it', async () => {
    await addUser('+919812344521');
    await addUser('+919898989898');
    const support = await admin('support_admin');

    for (const phone of ['98123 44521', '+91 98123 44521', '098123-44521']) {
      const found = await search(support, { phone });
      expect(found.users.map((u) => u.phone)).toEqual(['+91 98•• ••4521']);
    }
    for (const phone of ['4521', '981234']) {
      const res = await support.post('/admin/users/search', { phone });
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        'Enter the full 10-digit mobile number',
      );
    }
    expect((await search(support, { phone: '9000000000' })).users).toEqual([]);
  });

  it('filters by setup and account status', async () => {
    await addUser('+919811111111', { complete: true });
    const unfinished = await addUser('+919822222222');
    await db.updateTable('users').set({ status: 'blocked' }).where('id', '=', unfinished).execute();
    const support = await admin('support_admin');

    expect((await search(support, { setup: 'complete' })).users.map((u) => u.phone)).toEqual([
      '+91 98•• ••1111',
    ]);
    expect((await search(support, { setup: 'unfinished' })).users.map((u) => u.phone)).toEqual([
      '+91 98•• ••2222',
    ]);
    expect((await search(support, { status: 'blocked' })).users.map((u) => u.phone)).toEqual([
      '+91 98•• ••2222',
    ]);
  });

  it('a search is logged as a view, without the phone number', async () => {
    await addUser('+919812344521');
    const support = await admin('support_admin');
    await search(support, { phone: '9812344521' });
    const rows = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'users.searched')
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toEqual({ byPhone: true, setup: null, status: null });
    expect(JSON.stringify(await db.selectFrom('audit_log').selectAll().execute())).not.toContain(
      '9812344521',
    );
  });

  it('pages of 50 with "Load more"', async () => {
    await db
      .insertInto('users')
      .values(
        Array.from({ length: 70 }, (_, i) => ({ phone: `+9198${String(i).padStart(8, '0')}` })),
      )
      .execute();
    const support = await admin('support_admin');
    const first = await search(support);
    expect(first.users).toHaveLength(50);
    expect(first.more).toBe(true);
    const second = await search(support, { after: first.users[49].id });
    expect(second.users).toHaveLength(20);
    expect(second.more).toBe(false);
    const ids = [...first.users, ...second.users].map((u) => u.id);
    expect(new Set(ids).size).toBe(70);
  });
});

describe('profile', () => {
  it('shows setup, device, masked guardians and recent activity; the view is logged', async () => {
    const id = await addUser('+919812344521', { name: 'Priya', complete: true });
    await db
      .insertInto('sos_events')
      .values({
        id: randomUUID(),
        user_id: id,
        trigger: 'button',
        started_at: new Date(),
        status: 'ended',
      })
      .execute();
    const support = await admin('support_admin');
    const res = await support.get(`/admin/users/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: 'Priya',
      phone: '+91 98•• ••4521',
      setup: {
        complete: true,
        permissions: { location: true, notifications: true, sms: true, microphone: true },
        batteryOptimisationOff: true,
        guardianAccepted: true,
      },
      device: { model: 'Redmi Note 12', androidVersion: '14', appVersion: '1.0.0' },
      guardians: [{ name: 'Maa', phone: '+91 98•• ••0001', inviteStatus: 'accepted' }],
      activity: [{ type: 'sos', status: 'ended', trigger: 'button' }],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/9812344521|9800000001/);
    const views = await db
      .selectFrom('audit_log')
      .select('action')
      .where('action', '=', 'GET /admin/users/:id')
      .execute();
    expect(views).toHaveLength(1);
  });
});

describe('block and unblock', () => {
  it('both roles can, with a written reason, logged', async () => {
    const id = await addUser('+919812344521');
    const support = await admin('support_admin');
    expect((await support.post(`/admin/users/${id}/block`, { reason: 'short' })).status).toBe(400);
    expect((await support.post(`/admin/users/${id}/block`, { reason: REASON })).status).toBe(204);
    expect(
      (await db.selectFrom('users').select('status').where('id', '=', id).executeTakeFirstOrThrow())
        .status,
    ).toBe('blocked');
    expect((await support.post(`/admin/users/${id}/block`, { reason: REASON })).status).toBe(400);
    expect((await support.post(`/admin/users/${id}/unblock`, { reason: REASON })).status).toBe(204);
    const rows = await db
      .selectFrom('audit_log')
      .select(['action', 'reason', 'target_id'])
      .where('action', 'like', 'user.%')
      .orderBy('id')
      .execute();
    expect(rows).toEqual([
      { action: 'user.blocked', reason: REASON, target_id: id },
      { action: 'user.unblocked', reason: REASON, target_id: id },
    ]);
  });

  it('never ends an SOS or a journey already running', async () => {
    const id = await addUser('+919812344521');
    const sosId = randomUUID();
    await db
      .insertInto('sos_events')
      .values({ id: sosId, user_id: id, trigger: 'button', started_at: new Date() })
      .execute();
    await db.insertInto('journeys').values({ user_id: id }).execute();
    const support = await admin('support_admin');
    await support.post(`/admin/users/${id}/block`, { reason: REASON });
    expect(
      (
        await db
          .selectFrom('sos_events')
          .select('status')
          .where('id', '=', sosId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('active');
    expect(
      (
        await db
          .selectFrom('journeys')
          .select('status')
          .where('user_id', '=', id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('active');
  });
});

describe('delete data', () => {
  it('Super Admin only, with a reason; personal data goes, SOS events stay without a link', async () => {
    const id = await addUser('+919812344521', { complete: true });
    const sosId = randomUUID();
    await db
      .insertInto('sos_events')
      .values({
        id: sosId,
        user_id: id,
        trigger: 'button',
        started_at: new Date(),
        status: 'ended',
      })
      .execute();

    const support = await admin('support_admin');
    expect((await support.post(`/admin/users/${id}/delete-data`, { reason: REASON })).status).toBe(
      403,
    );

    const sa = await admin('super_admin');
    expect((await sa.post(`/admin/users/${id}/delete-data`, { reason: 'short' })).status).toBe(400);
    expect((await sa.post(`/admin/users/${id}/delete-data`, { reason: REASON })).status).toBe(204);

    expect(await db.selectFrom('users').select('id').where('id', '=', id).execute()).toEqual([]);
    expect(
      await db.selectFrom('guardians').select('id').where('user_id', '=', id).execute(),
    ).toEqual([]);
    const sos = await db
      .selectFrom('sos_events')
      .select('user_id')
      .where('id', '=', sosId)
      .executeTakeFirstOrThrow();
    expect(sos.user_id).toBeNull();
    const logged = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'user.data_deleted')
      .execute();
    expect(logged).toEqual([expect.objectContaining({ target_id: id, reason: REASON })]);
    expect((await sa.get(`/admin/users/${id}`)).status).toBe(404);
  });

  it('refused while an SOS or journey is running', async () => {
    const id = await addUser('+919812344521');
    await db.insertInto('journeys').values({ user_id: id }).execute();
    const sa = await admin('super_admin');
    const res = await sa.post(`/admin/users/${id}/delete-data`, { reason: REASON });
    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toMatch(/SOS or journey running/);
    expect(await db.selectFrom('users').select('id').where('id', '=', id).execute()).toHaveLength(
      1,
    );
  });

  it('refused while the user has audio recordings', async () => {
    const id = await addUser('+919812344521');
    const sosId = randomUUID();
    await db
      .insertInto('sos_events')
      .values({
        id: sosId,
        user_id: id,
        trigger: 'button',
        started_at: new Date(),
        status: 'ended',
      })
      .execute();
    await db
      .insertInto('media_clips')
      .values({
        user_id: id,
        sos_event_id: sosId,
        storage_key: 'audio/1.enc',
        delete_after: new Date(),
      })
      .execute();
    const sa = await admin('super_admin');
    const res = await sa.post(`/admin/users/${id}/delete-data`, { reason: REASON });
    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toMatch(/audio recordings/);
  });
});
