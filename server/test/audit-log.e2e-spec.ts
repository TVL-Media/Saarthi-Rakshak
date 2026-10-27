import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { sql, type Kysely } from 'kysely';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { configureApp } from '../src/app-setup';
import { AppModule } from '../src/app.module';
import type { AuditEntry } from '../src/audit/audit-log.service';
import { hashPassword } from '../src/auth/password';
import { ENV } from '../src/config/env.module';
import { activeConnections, validateEnv, type Env } from '../src/config/env.schema';
import type { Database } from '../src/database/types';
import { insertDefaultSettings } from '../src/setup/setup';
import { openTestDatabase, resetTestDatabase } from './test-database';

// Audit Log API. Login itself is tested elsewhere, so 2-step is off here (password only).
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

  async send(method: 'post' | 'patch', path: string, body: object = {}): Promise<Response> {
    let req = request(app.getHttpServer() as App)
      [method](path)
      .set('Origin', env.ADMIN_PANEL_ORIGIN);
    if (this.cookie) req = req.set('Cookie', this.cookie);
    const res = await req.send(body);
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    if (setCookie) this.cookie = setCookie[0].split(';')[0];
    return res;
  }
}

async function addAdmin(role: 'super_admin' | 'support_admin', email: string, name = email) {
  return (
    await db
      .insertInto('admins')
      .values({ name, email, role, password_hash: await hashPassword(PASSWORD) })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
}

async function logIn(email: string): Promise<Client> {
  const client = new Client();
  expect(
    (await client.send('post', '/admin/auth/login', { email, password: PASSWORD })).status,
  ).toBe(200);
  return client;
}

type Page = { entries: AuditEntry[]; more: boolean };
const page = async (client: Client, query = '') =>
  (await client.get(`/admin/audit${query}`)).body as Page;

describe('GET /admin/audit', () => {
  it('a Support Admin is refused (403)', async () => {
    await addAdmin('support_admin', 'support@example.test');
    const client = await logIn('support@example.test');
    expect((await client.get('/admin/audit')).status).toBe(403);
  });

  it('shows entries newest first, with admin and target names, and logs that the log was viewed', async () => {
    const sa = await addAdmin('super_admin', 'sa@example.test', 'Anjali Gupta');
    const client = await logIn('sa@example.test');
    const created = await client.send('post', '/admin/admins', {
      name: 'Ravi Kumar',
      email: 'ravi@example.test',
      role: 'support_admin',
    });
    const raviId = (created.body as { id: string }).id;

    const { entries } = await page(client);
    expect(entries.map((e) => e.action)).toEqual(
      ['admin.created', 'auth.login_succeeded', 'auth.password_accepted'].filter((a) =>
        entries.some((e) => e.action === a),
      ),
    );
    expect(entries[0]).toMatchObject({
      action: 'admin.created',
      kind: 'change',
      admin: { id: sa, name: 'Anjali Gupta' },
      targetId: raviId,
      targetName: 'Ravi Kumar',
      details: { role: 'support_admin' },
    });

    // Viewing the log is itself logged.
    const again = await page(client, '?kind=all&from=2000-01-01');
    expect(again.entries[0]).toMatchObject({ action: 'GET /admin/audit', kind: 'view' });
  });

  it('"Unknown email" logins: no admin, and the typed email is never stored', async () => {
    await addAdmin('super_admin', 'sa@example.test');
    await new Client().send('post', '/admin/auth/login', {
      email: 'my-secret-password@oops',
      password: 'x',
    });
    const client = await logIn('sa@example.test');
    const failed = (await page(client, '?kind=logins')).entries.find(
      (e) => e.action === 'auth.login_failed',
    );
    expect(failed).toMatchObject({ admin: null, reason: 'unknown email', kind: 'login' });
    const everything = JSON.stringify(await db.selectFrom('audit_log').selectAll().execute());
    expect(everything).not.toContain('my-secret-password');
  });

  it('filters by kind: changes only, logins only', async () => {
    await addAdmin('super_admin', 'sa@example.test');
    const client = await logIn('sa@example.test');
    await insertDefaultSettings(db);
    await client.get('/admin/settings'); // a view
    const settings = (await client.get('/admin/settings')).body as { version: string };
    await client.send('patch', '/admin/settings', {
      version: settings.version,
      reason: 'Pilot users found 3 minutes too short',
      values: { 'checkin.stopped_minutes': 4 },
    });

    const changes = (await page(client, '?kind=changes')).entries;
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.every((e) => e.kind === 'change')).toBe(true);
    expect(changes.map((e) => e.action)).toContain('settings.changed');

    const logins = (await page(client, '?kind=logins')).entries;
    expect(logins.length).toBeGreaterThan(0);
    expect(logins.every((e) => e.kind === 'login')).toBe(true);

    const all = (await page(client, '?kind=all')).entries;
    expect(all.some((e) => e.kind === 'view')).toBe(true);
  });

  it('filters by admin, including a removed admin', async () => {
    await addAdmin('super_admin', 'sa@example.test');
    const removed = await addAdmin('support_admin', 'gone@example.test');
    await logIn('gone@example.test');
    await db.updateTable('admins').set({ status: 'disabled' }).where('id', '=', removed).execute();

    const client = await logIn('sa@example.test');
    const theirs = (await page(client, `?admin=${removed}`)).entries;
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every((e) => e.admin?.id === removed)).toBe(true);
  });

  it('filters by India dates (from/to both included)', async () => {
    await addAdmin('super_admin', 'sa@example.test');
    // 14 Mar 2025, 23:30 India time = 18:00 UTC; 15 Mar 00:30 India = 19:00 UTC on the 14th.
    await db
      .insertInto('audit_log')
      .values([
        { action: 'test.late_on_14th', created_at: '2025-03-14T18:00:00Z' },
        { action: 'test.early_on_15th', created_at: '2025-03-14T19:00:00Z' },
      ])
      .execute();
    const client = await logIn('sa@example.test');
    const on14 = (await page(client, '?from=2025-03-14&to=2025-03-14')).entries.map(
      (e) => e.action,
    );
    expect(on14).toEqual(['test.late_on_14th']);
    const on15 = (await page(client, '?from=2025-03-15&to=2025-03-15')).entries.map(
      (e) => e.action,
    );
    expect(on15).toEqual(['test.early_on_15th']);
  });

  it('pages of 50 with "Load more": no duplicates, no gaps', async () => {
    await addAdmin('super_admin', 'sa@example.test');
    await db
      .insertInto('audit_log')
      .values(Array.from({ length: 120 }, (_, i) => ({ action: `test.entry_${i}` })))
      .execute();
    const client = await logIn('sa@example.test');

    const seen: string[] = [];
    let before = '';
    for (;;) {
      const p = await page(client, `?kind=changes${before ? `&before=${before}` : ''}`);
      seen.push(...p.entries.map((e) => e.id));
      if (!p.more) break;
      expect(p.entries).toHaveLength(50);
      before = p.entries[p.entries.length - 1].id;
    }
    const ids = seen.map(Number);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    const { rows } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM audit_log WHERE action LIKE 'test.%'
    `.execute(db);
    expect(seen.length).toBeGreaterThanOrEqual(Number(rows[0].n));
  });

  it('refuses bad filters', async () => {
    await addAdmin('super_admin', 'sa@example.test');
    const client = await logIn('sa@example.test');
    expect((await client.get('/admin/audit?from=27-10-2026')).status).toBe(400);
    expect((await client.get('/admin/audit?admin=not-an-id')).status).toBe(400);
    expect((await client.get('/admin/audit?kind=everything')).status).toBe(400);
  });

  it('has no route that changes or deletes entries', async () => {
    await addAdmin('super_admin', 'sa@example.test');
    const client = await logIn('sa@example.test');
    expect((await client.send('post', '/admin/audit')).status).toBe(404);
    expect((await client.send('patch', '/admin/audit')).status).toBe(404);
  });
});
