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
import { createMigrator } from '../src/database/migrator';
import type { Database } from '../src/database/types';
import { DEFAULT_SETTINGS } from '../src/settings/default-settings';
import { SETTINGS_CHANGED_ELSEWHERE, type SettingsView } from '../src/settings/settings.service';
import { insertDefaultSettings } from '../src/setup/setup';
import { openTestDatabase, resetTestDatabase } from './test-database';

// Settings screen API. Login itself is tested elsewhere, so 2-step is off here (password only).
let app: INestApplication;
let db: Kysely<Database>;
let redis: Redis;
let env: Env;
const PASSWORD = 'river-mango-lantern-42';
const REASON = 'Pilot users found 3 minutes too short';

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
  await insertDefaultSettings(db); // the real defaults, as the setup command saves them
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

  async send(method: 'post' | 'patch', path: string, body: object): Promise<Response> {
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

async function loggedIn(role: 'super_admin' | 'support_admin', email: string): Promise<Client> {
  await db
    .insertInto('admins')
    .values({ name: role, email, role, password_hash: await hashPassword(PASSWORD) })
    .execute();
  const client = new Client();
  const res = await client.send('post', '/admin/auth/login', { email, password: PASSWORD });
  expect(res.body).toEqual({ next: 'done' });
  return client;
}

const view = async (client: Client) => (await client.get('/admin/settings')).body as SettingsView;
const settingRows = () =>
  db.selectFrom('settings').select(['key', 'value']).orderBy('key').execute();
const changeRows = () =>
  db
    .selectFrom('audit_log')
    .select(['action', 'target_id', 'reason', 'details'])
    .where('action', '=', 'settings.changed')
    .orderBy('id')
    .execute();

describe('GET /admin/settings', () => {
  it('shows the 29 saved defaults (Phase 1 and 2) with their ranges, and logs the view', async () => {
    const sa = await loggedIn('super_admin', 'sa@example.test');
    const body = await view(sa);
    expect(body.settings).toHaveLength(29);
    expect(body.settings).toContainEqual({
      key: 'sos.countdown_seconds',
      value: 5,
      min: 3,
      max: 10,
    });
    expect(body.settings).toContainEqual({
      key: 'audio.auto_delete_days',
      value: 30,
      min: 7,
      max: 90,
    });
    expect(body.settings.map((s) => s.key)).not.toContain('sos.cancel_requires_pin');
    const views = await db
      .selectFrom('audit_log')
      .select('action')
      .where('action', '=', 'GET /admin/settings')
      .execute();
    expect(views).toHaveLength(1);
  });

  it('every default is inside its own range', () => {
    for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
      expect([key, def.value >= def.min && def.value <= def.max]).toEqual([key, true]);
    }
  });

  it('a Support Admin is refused (403), for viewing and saving', async () => {
    const support = await loggedIn('support_admin', 'support@example.test');
    expect((await support.get('/admin/settings')).status).toBe(403);
    const save = await support.send('patch', '/admin/settings', {
      version: 'x',
      reason: REASON,
      values: { 'checkin.stopped_minutes': 4 },
    });
    expect(save.status).toBe(403);
    expect((await settingRows()).find((r) => r.key === 'checkin.stopped_minutes')?.value).toBe(3);
  });
});

describe('PATCH /admin/settings', () => {
  it('saves a change and logs before/after values with the reason', async () => {
    const sa = await loggedIn('super_admin', 'sa@example.test');
    const { version } = await view(sa);
    const res = await sa.send('patch', '/admin/settings', {
      version,
      reason: REASON,
      values: { 'checkin.stopped_minutes': 4 },
    });
    expect(res.status).toBe(200);
    expect((res.body as { changed: number }).changed).toBe(1);
    expect((await settingRows()).find((r) => r.key === 'checkin.stopped_minutes')?.value).toBe(4);
    expect(await changeRows()).toEqual([
      {
        action: 'settings.changed',
        target_id: 'checkin.stopped_minutes',
        reason: REASON,
        details: { setting: 'checkin.stopped_minutes', before: 3, after: 4 },
      },
    ]);
  });

  it('ignores values that did not change (no audit rows)', async () => {
    const sa = await loggedIn('super_admin', 'sa@example.test');
    const { version } = await view(sa);
    const res = await sa.send('patch', '/admin/settings', {
      version,
      reason: REASON,
      values: { 'checkin.stopped_minutes': 3, 'guardian.max_count': 5 },
    });
    expect((res.body as { changed: number }).changed).toBe(0);
    expect(await changeRows()).toEqual([]);
  });

  it.each([
    [{ 'sos.countdown_seconds': 11 }, /sos\.countdown_seconds: Must be 10 or less/],
    [{ 'audio.auto_delete_days': 6 }, /audio\.auto_delete_days: Must be 7 or more/],
    [{ 'checkin.off_route_metres': 250.5 }, /Must be a whole number/],
    [{ 'sos.cancel_requires_pin': 1 }, /Unrecognized key|unrecognized/i],
  ])('refuses %j and saves nothing', async (values, message) => {
    const sa = await loggedIn('super_admin', 'sa@example.test');
    const before = await settingRows();
    const { version } = await view(sa);
    const res = await sa.send('patch', '/admin/settings', {
      version,
      reason: REASON,
      values: { 'checkin.stopped_minutes': 4, ...values },
    });
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toMatch(message);
    expect(await settingRows()).toEqual(before);
    expect(await changeRows()).toEqual([]);
  });

  it('needs a written reason', async () => {
    const sa = await loggedIn('super_admin', 'sa@example.test');
    const { version } = await view(sa);
    const res = await sa.send('patch', '/admin/settings', {
      version,
      reason: 'short',
      values: { 'checkin.stopped_minutes': 4 },
    });
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toMatch(/Write a reason/);
  });

  it('refuses a save based on an old version (two admins editing at once)', async () => {
    const first = await loggedIn('super_admin', 'sa1@example.test');
    const second = await loggedIn('super_admin', 'sa2@example.test');
    const seenByBoth = (await view(first)).version;

    const ok = await first.send('patch', '/admin/settings', {
      version: seenByBoth,
      reason: REASON,
      values: { 'checkin.stopped_minutes': 4 },
    });
    expect(ok.status).toBe(200);

    const late = await second.send('patch', '/admin/settings', {
      version: seenByBoth,
      reason: REASON,
      values: { 'checkin.stopped_minutes': 6 },
    });
    expect(late.status).toBe(409);
    expect((late.body as { message: string }).message).toBe(SETTINGS_CHANGED_ELSEWHERE);
    expect((await settingRows()).find((r) => r.key === 'checkin.stopped_minutes')?.value).toBe(4);
  });
});

describe('migration 0008', () => {
  it('removes only the old "cancel requires PIN" row', async () => {
    await db
      .insertInto('settings')
      .values({ key: 'sos.cancel_requires_pin', value: 'false' })
      .execute();
    const others = (await settingRows()).filter((r) => r.key !== 'sos.cancel_requires_pin');
    const migrator = createMigrator(db);
    await migrator.migrateTo('0007_admin_auth'); // undo 0008 (and anything after it) ...
    await migrator.migrateToLatest(); // ... and run it again
    expect(await settingRows()).toEqual(others);
  });

  it('audit_log stays append-only with the new column', async () => {
    await db.insertInto('audit_log').values({ action: 'test', details: '{"a":1}' }).execute();
    await expect(db.updateTable('audit_log').set({ action: 'x' }).execute()).rejects.toThrow(
      /append-only/,
    );
  });
});
