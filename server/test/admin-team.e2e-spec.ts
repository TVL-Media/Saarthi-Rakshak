import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import type { Kysely } from 'kysely';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { configureApp } from '../src/app-setup';
import { AppModule } from '../src/app.module';
import { hashPassword, verifyPassword } from '../src/auth/password';
import { ENV } from '../src/config/env.module';
import { activeConnections, validateEnv, type Env } from '../src/config/env.schema';
import type { Database } from '../src/database/types';
import { openTestDatabase, resetTestDatabase } from './test-database';

// Admin Team API. Login itself is tested elsewhere, so 2-step is off here (password only).
let app: INestApplication;
let db: Kysely<Database>;
let redis: Redis;
let env: Env;
const PASSWORD = 'river-mango-lantern-42';
const REASON = 'Left the company last week';
const HOUR = 3_600_000;

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

async function addAdmin(role: 'super_admin' | 'support_admin', email: string): Promise<string> {
  const row = await db
    .insertInto('admins')
    .values({ name: `Name ${email}`, email, role, password_hash: await hashPassword(PASSWORD) })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function logIn(email: string, password = PASSWORD): Promise<Client> {
  const client = new Client();
  const res = await client.post('/admin/auth/login', { email, password });
  expect(res.status).toBe(200);
  return client;
}

const admin = (id: string) =>
  db.selectFrom('admins').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const auditRows = (action: string) =>
  db.selectFrom('audit_log').selectAll().where('action', '=', action).orderBy('id').execute();

describe('adding an admin', () => {
  it('creates a Support Admin with a one-time temporary password (stored only as a hash)', async () => {
    const sa = await addAdmin('super_admin', 'sa@example.test');
    const client = await logIn('sa@example.test');

    const res = await client.post('/admin/admins', {
      name: 'Ravi Kumar',
      email: 'Ravi@Example.test',
      role: 'support_admin',
    });
    expect(res.status).toBe(201);
    const { id, temporaryPassword } = res.body as { id: string; temporaryPassword: string };

    const row = await admin(id);
    expect(row).toMatchObject({
      name: 'Ravi Kumar',
      email: 'ravi@example.test',
      role: 'support_admin',
      status: 'active',
      must_change_password: true,
    });
    expect(row.password_hash).not.toContain(temporaryPassword);
    expect(await verifyPassword(temporaryPassword, row.password_hash)).toBe(true);
    expect(row.password_expires_at!.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);

    const [created] = await auditRows('admin.created');
    expect(created).toMatchObject({
      admin_id: sa,
      target_id: id,
      details: { role: 'support_admin' },
    });
    // The temporary password is never written to the audit log.
    const everything = JSON.stringify(await db.selectFrom('audit_log').selectAll().execute());
    expect(everything).not.toContain(temporaryPassword);

    // The new admin logs in with it and must set their own password first.
    const ravi = new Client();
    const login = await ravi.post('/admin/auth/login', {
      email: 'ravi@example.test',
      password: temporaryPassword,
    });
    expect(login.body).toEqual({ next: 'change_password' });
  });

  it('refuses an email already in use, and a removed admin’s email', async () => {
    await addAdmin('super_admin', 'sa@example.test');
    const removed = await addAdmin('support_admin', 'gone@example.test');
    await db.updateTable('admins').set({ status: 'disabled' }).where('id', '=', removed).execute();
    const client = await logIn('sa@example.test');

    const same = await client.post('/admin/admins', {
      name: 'X',
      email: 'sa@example.test',
      role: 'support_admin',
    });
    expect(same.status).toBe(409);
    expect((same.body as { message: string }).message).toBe(
      'An admin with this email already exists.',
    );

    const old = await client.post('/admin/admins', {
      name: 'X',
      email: 'GONE@example.test',
      role: 'support_admin',
    });
    expect(old.status).toBe(409);
    expect((old.body as { message: string }).message).toBe(
      'This email belongs to a removed admin.',
    );
  });

  it('checks the fields', async () => {
    await addAdmin('super_admin', 'sa@example.test');
    const client = await logIn('sa@example.test');
    const bad = [
      { name: ' ', email: 'a@example.test', role: 'support_admin' },
      { name: 'A', email: 'not-an-email', role: 'support_admin' },
      { name: 'A', email: 'a@example.test', role: 'boss' },
    ];
    for (const body of bad) {
      expect((await client.post('/admin/admins', body)).status).toBe(400);
    }
  });
});

describe('resetting a password', () => {
  it('gives a Support Admin a new temporary password, turns off 2-step and logs them out', async () => {
    await addAdmin('super_admin', 'sa@example.test');
    const supportId = await addAdmin('support_admin', 'support@example.test');
    await db
      .updateTable('admins')
      .set({ totp_enabled_at: new Date(), totp_secret_encrypted: 'x', failed_login_count: 3 })
      .where('id', '=', supportId)
      .execute();
    const supportClient = await logIn('support@example.test');
    const client = await logIn('sa@example.test');

    const res = await client.post(`/admin/admins/${supportId}/reset-password`);
    expect(res.status).toBe(200);
    const { temporaryPassword } = res.body as { temporaryPassword: string };

    const row = await admin(supportId);
    expect(await verifyPassword(temporaryPassword, row.password_hash)).toBe(true);
    expect(await verifyPassword(PASSWORD, row.password_hash)).toBe(false);
    expect(row).toMatchObject({
      must_change_password: true,
      totp_enabled_at: null,
      totp_secret_encrypted: null,
      failed_login_count: 0,
    });
    expect((await supportClient.get('/admin/auth/me')).status).toBe(401);
    expect(await auditRows('admin.password_reset')).toHaveLength(1);
  });

  it('is refused for a Super Admin (they use --reissue)', async () => {
    await addAdmin('super_admin', 'sa@example.test');
    const other = await addAdmin('super_admin', 'sa2@example.test');
    const client = await logIn('sa@example.test');
    const res = await client.post(`/admin/admins/${other}/reset-password`);
    expect(res.status).toBe(403);
    expect(await verifyPassword(PASSWORD, (await admin(other)).password_hash)).toBe(true);
  });
});

describe('removing an admin', () => {
  it('disables the account (history stays), logs them out, and needs a reason', async () => {
    const sa = await addAdmin('super_admin', 'sa@example.test');
    const supportId = await addAdmin('support_admin', 'support@example.test');
    const supportClient = await logIn('support@example.test');
    const client = await logIn('sa@example.test');

    expect(
      (await client.post(`/admin/admins/${supportId}/remove`, { reason: 'short' })).status,
    ).toBe(400);
    const res = await client.post(`/admin/admins/${supportId}/remove`, { reason: REASON });
    expect(res.status).toBe(204);

    expect((await admin(supportId)).status).toBe('disabled');
    expect((await supportClient.get('/admin/auth/me')).status).toBe(401);
    const login = await new Client().post('/admin/auth/login', {
      email: 'support@example.test',
      password: PASSWORD,
    });
    expect(login.status).toBe(401);
    expect((await auditRows('admin.removed'))[0]).toMatchObject({
      admin_id: sa,
      target_id: supportId,
      reason: REASON,
    });

    // Removed admins stay in the list, last, marked as removed.
    const list = (await client.get('/admin/admins')).body as { email: string; removed: boolean }[];
    expect(list.map((a) => [a.email, a.removed])).toEqual([
      ['sa@example.test', false],
      ['support@example.test', true],
    ]);
  });

  it('never yourself, never the last Super Admin, never twice', async () => {
    const sa = await addAdmin('super_admin', 'sa@example.test');
    const sa2 = await addAdmin('super_admin', 'sa2@example.test');
    const client = await logIn('sa@example.test');

    expect((await client.post(`/admin/admins/${sa}/remove`, { reason: REASON })).status).toBe(400);
    expect((await client.post(`/admin/admins/${sa2}/remove`, { reason: REASON })).status).toBe(204);
    expect((await client.post(`/admin/admins/${sa2}/remove`, { reason: REASON })).status).toBe(400);
    expect((await admin(sa)).status).toBe('active');
  });

  it('never leaves zero Super Admins (the last active one cannot be removed by another)', async () => {
    await addAdmin('super_admin', 'sa@example.test');
    const sa2 = await addAdmin('super_admin', 'sa2@example.test');
    // sa2 removes sa ... then nobody may remove sa2.
    const client2 = await logIn('sa2@example.test');
    const sa = (
      await db
        .selectFrom('admins')
        .select('id')
        .where('email', '=', 'sa@example.test')
        .executeTakeFirstOrThrow()
    ).id;
    expect((await client2.post(`/admin/admins/${sa}/remove`, { reason: REASON })).status).toBe(204);
    const active = await db
      .selectFrom('admins')
      .select('id')
      .where('role', '=', 'super_admin')
      .where('status', '=', 'active')
      .execute();
    expect(active.map((r) => r.id)).toEqual([sa2]);
  });
});

describe('roles', () => {
  it('a Support Admin cannot add, reset or remove admins', async () => {
    await addAdmin('super_admin', 'sa@example.test');
    const other = await addAdmin('support_admin', 'other@example.test');
    await addAdmin('support_admin', 'support@example.test');
    const client = await logIn('support@example.test');
    expect(
      (
        await client.post('/admin/admins', {
          name: 'A',
          email: 'a@example.test',
          role: 'super_admin',
        })
      ).status,
    ).toBe(403);
    expect((await client.post(`/admin/admins/${other}/reset-password`)).status).toBe(403);
    expect((await client.post(`/admin/admins/${other}/remove`, { reason: REASON })).status).toBe(
      403,
    );
  });
});
