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
import { createFirstSuperAdmin } from '../src/setup/setup';
import { openTestDatabase, resetTestDatabase } from './test-database';

// The same server with ADMIN_TWO_STEP=off (the local development default).
let app: INestApplication;
let db: Kysely<Database>;
let redis: Redis;
let env: Env;

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

/** Keeps the session cookie between requests, like a browser. */
class Client {
  cookie?: string;

  async post(path: string, body?: object): Promise<Response> {
    let req = request(app.getHttpServer() as App)
      .post(path)
      .set('Origin', env.ADMIN_PANEL_ORIGIN);
    if (this.cookie) req = req.set('Cookie', this.cookie);
    return this.keep(await (body ? req.send(body) : req));
  }

  async get(path: string): Promise<Response> {
    let req = request(app.getHttpServer() as App).get(path);
    if (this.cookie) req = req.set('Cookie', this.cookie);
    return this.keep(await req);
  }

  private keep(res: Response): Response {
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    if (setCookie) this.cookie = setCookie[0].split(';')[0];
    return res;
  }
}

const auditActions = async () =>
  (await db.selectFrom('audit_log').select(['action', 'reason']).orderBy('id').execute()).map(
    (r) => `${r.action}${r.reason ? ` (${r.reason})` : ''}`,
  );

describe('ADMIN_TWO_STEP=off', () => {
  it('tells the panel 2-step login is off', async () => {
    expect((await new Client().get('/admin/auth/options')).body).toEqual({ twoStep: false });
  });

  it('first login: temporary password → new password → full login, no 2-step', async () => {
    const issued = await createFirstSuperAdmin(db, { name: 'First', email: 'first@example.test' });
    const client = new Client();

    const login = await client.post('/admin/auth/login', {
      email: 'first@example.test',
      password: issued.temporaryPassword,
    });
    expect(login.body).toEqual({ next: 'change_password' });
    expect((await client.get('/admin/auth/me')).status).toBe(401);

    const changed = await client.post('/admin/auth/password', {
      newPassword: 'river-mango-lantern-42',
    });
    expect(changed.body).toEqual({ next: 'done' });
    expect((await client.get('/admin/auth/me')).body).toMatchObject({
      email: 'first@example.test',
      role: 'super_admin',
    });
    expect(await auditActions()).toEqual([
      'setup.super_admin_created',
      'auth.password_accepted (next: change_password)',
      'auth.password_changed',
      'auth.login_succeeded (password only (2-step login is off))',
    ]);
  });

  it('normal login: password goes straight to a full session', async () => {
    await db
      .insertInto('admins')
      .values({
        name: 'Support',
        email: 'support@example.test',
        role: 'support_admin',
        password_hash: await hashPassword('river-mango-lantern-42'),
      })
      .execute();
    const client = new Client();
    const login = await client.post('/admin/auth/login', {
      email: 'support@example.test',
      password: 'river-mango-lantern-42',
    });
    expect(login.body).toEqual({ next: 'done' });
    expect((await client.get('/admin/auth/me')).status).toBe(200);
  });

  it('the 2-step routes are not available', async () => {
    await db
      .insertInto('admins')
      .values({
        name: 'Admin',
        email: 'admin@example.test',
        role: 'super_admin',
        password_hash: await hashPassword('river-mango-lantern-42'),
      })
      .execute();
    const client = new Client();
    await client.post('/admin/auth/login', {
      email: 'admin@example.test',
      password: 'river-mango-lantern-42',
    });
    const regenerate = await client.post('/admin/auth/2fa/backup-codes', { code: '123456' });
    expect(regenerate.status).toBe(404);
    expect((regenerate.body as { message: string }).message).toBe('2-step login is turned off');
  });

  it('wrong passwords still lock the account after 5 tries', async () => {
    await db
      .insertInto('admins')
      .values({
        name: 'Admin',
        email: 'admin@example.test',
        role: 'super_admin',
        password_hash: await hashPassword('river-mango-lantern-42'),
      })
      .execute();
    for (let i = 0; i < 5; i++) {
      await new Client().post('/admin/auth/login', {
        email: 'admin@example.test',
        password: 'wrong',
      });
    }
    const right = await new Client().post('/admin/auth/login', {
      email: 'admin@example.test',
      password: 'river-mango-lantern-42',
    });
    expect(right.status).toBe(401);
  });
});
