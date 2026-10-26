import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import type { Kysely } from 'kysely';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { configureApp } from '../src/app-setup';
import { AppModule } from '../src/app.module';
import { deriveAuthKeys } from '../src/auth/auth-keys';
import { IP_ATTEMPT_LIMIT, LOGIN_FAILED_MESSAGE } from '../src/auth/auth.constants';
import { base32Decode } from '../src/auth/base32';
import { encrypt } from '../src/auth/crypto-box';
import { hashPassword } from '../src/auth/password';
import { timeStep, totpCode } from '../src/auth/totp';
import { activeConnections, validateEnv, type Env } from '../src/config/env.schema';
import type { Database } from '../src/database/types';
import { createFirstSuperAdmin, reissueSuperAdminPassword } from '../src/setup/setup';
import { openTestDatabase, resetTestDatabase } from './test-database';

let app: INestApplication;
let db: Kysely<Database>;
let redis: Redis;
let env: Env;
const MINUTE = 60_000;

beforeAll(async () => {
  db = await openTestDatabase();
  env = validateEnv(process.env);
  redis = new Redis(activeConnections(env).redisUrl);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  configureApp(app, env);
  await app.init();
});

beforeEach(async () => {
  await resetTestDatabase(db);
  await redis.flushdb(); // the test slot only (checked at startup to differ from development)
});

afterAll(async () => {
  await app?.close();
  redis?.disconnect();
  await db?.destroy();
});

/** A browser-like client: sends the panel's Origin and keeps the session cookie. */
class Client {
  cookie?: string;
  constructor(private readonly origin: string | null = env.ADMIN_PANEL_ORIGIN) {}

  async post(path: string, body?: object): Promise<Response> {
    let req = request(app.getHttpServer() as App).post(path);
    if (this.origin) req = req.set('Origin', this.origin);
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
    if (setCookie) {
      const pair = setCookie[0].split(';')[0];
      this.cookie = pair.endsWith('=') ? undefined : pair;
    }
    return res;
  }
}

interface TestAdmin {
  id: string;
  email: string;
  password: string;
  secret: Buffer;
}

/** An admin with a known password and 2-step already set up (only in sarthi_test). */
async function createAdmin(
  role: 'super_admin' | 'support_admin',
  email: string,
): Promise<TestAdmin> {
  const password = 'test-password-' + randomBytes(4).toString('hex');
  const secret = randomBytes(20);
  const row = await db
    .insertInto('admins')
    .values({
      name: role,
      email,
      role,
      password_hash: await hashPassword(password),
      totp_enabled_at: new Date(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const keys = deriveAuthKeys(env.ADMIN_TOTP_ENCRYPTION_KEY);
  await db
    .updateTable('admins')
    .set({ totp_secret_encrypted: encrypt(keys.totpSecretKey, secret, row.id) })
    .where('id', '=', row.id)
    .execute();
  return { id: row.id, email, password, secret };
}

/**
 * A valid code not used before. Codes are single-use per 30-second step; when a test needs
 * more, the stored last step is moved back, which is the same as waiting for the next step.
 */
async function freshCode(adminId: string, secret: Buffer): Promise<string> {
  const current = timeStep(Date.now());
  const row = await db
    .selectFrom('admins')
    .select('totp_last_step')
    .where('id', '=', adminId)
    .executeTakeFirstOrThrow();
  const last = row.totp_last_step === null ? null : Number(row.totp_last_step);
  if (last === null || last < current) return totpCode(secret, current);
  await db
    .updateTable('admins')
    .set({ totp_last_step: current - 2 })
    .where('id', '=', adminId)
    .execute();
  return totpCode(secret, current);
}

async function loginFully(admin: TestAdmin, client = new Client()): Promise<Client> {
  const login = await client.post('/admin/auth/login', {
    email: admin.email,
    password: admin.password,
  });
  expect(login.body).toEqual({ next: 'verify_2fa' });
  const verify = await client.post('/admin/auth/2fa/verify', {
    code: await freshCode(admin.id, admin.secret),
  });
  expect(verify.status).toBe(200);
  return client;
}

const auditRows = () => db.selectFrom('audit_log').selectAll().orderBy('id').execute();
const auditActions = async () => (await auditRows()).map((r) => r.action);

describe('first login (temporary password → new password → 2-step setup)', () => {
  it('runs the whole way, rotating the session at every step', async () => {
    const issued = await createFirstSuperAdmin(db, { name: 'First', email: 'first@example.test' });
    const client = new Client();

    const login = await client.post('/admin/auth/login', {
      email: 'FIRST@example.test',
      password: issued.temporaryPassword,
    });
    expect(login.status).toBe(200);
    expect(login.body).toEqual({ next: 'change_password' });
    const cookieHeader = (login.headers['set-cookie'] as unknown as string[])[0];
    expect(cookieHeader).toMatch(
      /^__Host-sr_admin=[\w-]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=600$/,
    );

    // A half-finished login cannot reach anything else.
    expect((await client.get('/admin/auth/me')).status).toBe(401);
    expect((await client.get('/admin/admins')).status).toBe(401);

    const weak = await client.post('/admin/auth/password', { newPassword: 'short' });
    expect(weak.status).toBe(400);
    const same = await client.post('/admin/auth/password', {
      newPassword: issued.temporaryPassword,
    });
    expect(same.status).toBe(400);

    const pendingCookie = client.cookie;
    const changed = await client.post('/admin/auth/password', {
      newPassword: 'river-mango-lantern-42',
    });
    expect(changed.body).toEqual({ next: 'setup_2fa' });
    const old = new Client();
    old.cookie = pendingCookie;
    expect((await old.post('/admin/auth/2fa/setup')).status).toBe(401);

    const setup = await client.post('/admin/auth/2fa/setup');
    expect(setup.status).toBe(200);
    const body = setup.body as { otpauthUrl: string; secret: string };
    expect(body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const secret = base32Decode(body.secret);

    const wrong = await client.post('/admin/auth/2fa/setup/confirm', { code: '000000' });
    expect(wrong.status).toBe(401);
    const confirm = await client.post('/admin/auth/2fa/setup/confirm', {
      code: totpCode(secret, timeStep(Date.now())),
    });
    expect(confirm.status).toBe(200);
    const { backupCodes } = confirm.body as { backupCodes: string[] };
    expect(backupCodes).toHaveLength(10);

    const me = await client.get('/admin/auth/me');
    expect(me.body).toEqual({
      id: issued.adminId,
      name: 'First',
      email: 'first@example.test',
      role: 'super_admin',
      backupCodesLeft: 10,
    });

    const admin = await db.selectFrom('admins').selectAll().executeTakeFirstOrThrow();
    expect(admin).toMatchObject({ must_change_password: false, password_expires_at: null });
    expect(admin.totp_enabled_at).not.toBeNull();

    expect(await auditActions()).toEqual([
      'setup.super_admin_created',
      'auth.password_accepted',
      'auth.password_changed',
      'auth.2fa_setup_started',
      'auth.2fa_failed',
      'auth.2fa_enabled',
      'auth.login_succeeded',
    ]);
  });

  it('refuses an expired temporary password', async () => {
    const issued = await createFirstSuperAdmin(db, { name: 'First', email: 'first@example.test' });
    await db
      .updateTable('admins')
      .set({ password_expires_at: new Date(Date.now() - MINUTE) })
      .execute();
    const res = await new Client().post('/admin/auth/login', {
      email: 'first@example.test',
      password: issued.temporaryPassword,
    });
    expect(res.status).toBe(401);
    expect((await auditRows()).at(-1)).toMatchObject({ reason: 'temporary password expired' });
  });
});

describe('normal login with 2-step', () => {
  it('logs in with an authenticator code; the same code cannot be used again', async () => {
    const admin = await createAdmin('super_admin', 'sa@example.test');
    const client = await loginFully(admin);
    expect((await client.get('/admin/auth/me')).status).toBe(200);

    const usedStep = Number(
      (await db.selectFrom('admins').select('totp_last_step').executeTakeFirstOrThrow())
        .totp_last_step,
    );
    const again = new Client();
    await again.post('/admin/auth/login', { email: admin.email, password: admin.password });
    const replay = await again.post('/admin/auth/2fa/verify', {
      code: totpCode(admin.secret, usedStep),
    });
    expect(replay.status).toBe(401);
  });

  it('accepts each backup code once', async () => {
    const admin = await createAdmin('super_admin', 'sa@example.test');
    const client = await loginFully(admin);
    const { backupCodes } = (
      await client.post('/admin/auth/2fa/backup-codes', {
        code: await freshCode(admin.id, admin.secret),
      })
    ).body as { backupCodes: string[] };

    const first = new Client();
    await first.post('/admin/auth/login', { email: admin.email, password: admin.password });
    const used = await first.post('/admin/auth/2fa/verify', {
      backupCode: backupCodes[0].toLowerCase(),
    });
    expect(used.body).toEqual({ next: 'done', backupCodesLeft: 9 });
    expect(await auditActions()).toContain('auth.backup_code_used');

    const second = new Client();
    await second.post('/admin/auth/login', { email: admin.email, password: admin.password });
    expect(
      (await second.post('/admin/auth/2fa/verify', { backupCode: backupCodes[0] })).status,
    ).toBe(401);
  });

  it('new backup codes replace the old ones', async () => {
    const admin = await createAdmin('super_admin', 'sa@example.test');
    const client = await loginFully(admin);
    const regen = () =>
      freshCode(admin.id, admin.secret).then((code) =>
        client.post('/admin/auth/2fa/backup-codes', { code }),
      );
    const oldCodes = ((await regen()).body as { backupCodes: string[] }).backupCodes;
    await regen();

    const c = new Client();
    await c.post('/admin/auth/login', { email: admin.email, password: admin.password });
    expect((await c.post('/admin/auth/2fa/verify', { backupCode: oldCodes[0] })).status).toBe(401);
    expect(await auditActions()).toContain('auth.backup_codes_regenerated');
  });
});

describe('failures, lockout and rate limits', () => {
  it('gives the same reply for an unknown email and a wrong password', async () => {
    await createAdmin('super_admin', 'sa@example.test');
    const unknown = await new Client().post('/admin/auth/login', {
      email: 'no@example.test',
      password: 'x',
    });
    const wrong = await new Client().post('/admin/auth/login', {
      email: 'sa@example.test',
      password: 'x',
    });
    expect([unknown.status, wrong.status]).toEqual([401, 401]);
    expect(unknown.body).toEqual(wrong.body);
    expect((unknown.body as { message: string }).message).toBe(LOGIN_FAILED_MESSAGE);
  });

  it('locks the account after 5 wrong passwords, even for the right password', async () => {
    const admin = await createAdmin('super_admin', 'sa@example.test');
    for (let i = 0; i < 5; i++) {
      await new Client().post('/admin/auth/login', { email: admin.email, password: 'wrong' });
    }
    const right = await new Client().post('/admin/auth/login', {
      email: admin.email,
      password: admin.password,
    });
    expect(right.status).toBe(401);
    expect(await auditActions()).toContain('auth.account_locked');

    // After the lock time (moved into the past here) the right password works again.
    await db
      .updateTable('admins')
      .set({ locked_until: new Date(Date.now() - MINUTE) })
      .execute();
    const later = await new Client().post('/admin/auth/login', {
      email: admin.email,
      password: admin.password,
    });
    expect(later.body).toEqual({ next: 'verify_2fa' });
  });

  it('counts wrong 2-step codes too, and ends the half-finished login when locked', async () => {
    const admin = await createAdmin('super_admin', 'sa@example.test');
    const client = new Client();
    await client.post('/admin/auth/login', { email: admin.email, password: admin.password });
    for (let i = 0; i < 5; i++) await client.post('/admin/auth/2fa/verify', { code: '000000' });

    const good = await client.post('/admin/auth/2fa/verify', {
      code: await freshCode(admin.id, admin.secret),
    });
    expect(good.status).toBe(401);
    const row = await db.selectFrom('admins').select('locked_until').executeTakeFirstOrThrow();
    expect(row.locked_until!.getTime()).toBeGreaterThan(Date.now());
  });

  it(`allows ${IP_ATTEMPT_LIMIT} attempts per IP address, then answers 429`, async () => {
    for (let i = 0; i < IP_ATTEMPT_LIMIT; i++) {
      const res = await new Client().post('/admin/auth/login', {
        email: `x${i}@example.test`,
        password: 'x',
      });
      expect(res.status).toBe(401);
    }
    const blocked = await new Client().post('/admin/auth/login', {
      email: 'y@example.test',
      password: 'x',
    });
    expect(blocked.status).toBe(429);
  });
});

describe('sessions', () => {
  it('ends after 30 minutes without activity', async () => {
    const admin = await createAdmin('super_admin', 'sa@example.test');
    const client = await loginFully(admin);
    await db
      .updateTable('admin_sessions')
      .set({ last_seen_at: new Date(Date.now() - 31 * MINUTE) })
      .where('stage', '=', 'full')
      .execute();
    expect((await client.get('/admin/auth/me')).status).toBe(401);
    const ended = await auditRows();
    expect(ended.at(-1)).toMatchObject({ action: 'auth.session_expired', reason: 'idle' });
  });

  it('ends at the latest 12 hours after login', async () => {
    const admin = await createAdmin('super_admin', 'sa@example.test');
    const client = await loginFully(admin);
    await db
      .updateTable('admin_sessions')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .execute();
    expect((await client.get('/admin/auth/me')).status).toBe(401);
  });

  it('logout ends the session and clears the cookie', async () => {
    const admin = await createAdmin('super_admin', 'sa@example.test');
    const client = await loginFully(admin);
    const cookie = client.cookie;
    const out = await client.post('/admin/auth/logout');
    expect(out.status).toBe(204);
    expect((out.headers['set-cookie'] as unknown as string[])[0]).toMatch(/Max-Age=0/);

    const reused = new Client();
    reused.cookie = cookie;
    expect((await reused.get('/admin/auth/me')).status).toBe(401);
    expect(await auditActions()).toContain('auth.logout');
  });

  it('changing the password needs the current one and ends the other sessions', async () => {
    const admin = await createAdmin('super_admin', 'sa@example.test');
    const laptop = await loginFully(admin);
    const phone = await loginFully(admin);

    const wrong = await laptop.post('/admin/auth/password', {
      currentPassword: 'nope',
      newPassword: 'river-mango-lantern-42',
    });
    expect(wrong.status).toBe(401);

    const ok = await laptop.post('/admin/auth/password', {
      currentPassword: admin.password,
      newPassword: 'river-mango-lantern-42',
    });
    expect(ok.body).toEqual({ next: 'done' });
    expect((await laptop.get('/admin/auth/me')).status).toBe(200);
    expect((await phone.get('/admin/auth/me')).status).toBe(401);
  });

  it('a disabled admin is logged out and cannot log in', async () => {
    const admin = await createAdmin('super_admin', 'sa@example.test');
    const client = await loginFully(admin);
    await db.updateTable('admins').set({ status: 'disabled' }).execute();
    expect((await client.get('/admin/auth/me')).status).toBe(401);
    const login = await new Client().post('/admin/auth/login', {
      email: admin.email,
      password: admin.password,
    });
    expect(login.status).toBe(401);
  });
});

describe('why a session ended (shown on the login page)', () => {
  const ended = (reason: string, extra = {}) => ({
    statusCode: 401,
    message: 'Not logged in, or the session has ended',
    reason,
    ...extra,
  });

  it('no cookie: no_session', async () => {
    expect((await new Client().get('/admin/auth/me')).body).toEqual(ended('no_session'));
  });

  it('30 minutes idle: idle, also on every later request', async () => {
    const admin = await createAdmin('super_admin', 'sa@example.test');
    const client = await loginFully(admin);
    await db
      .updateTable('admin_sessions')
      .set({ last_seen_at: new Date(Date.now() - 31 * MINUTE) })
      .where('stage', '=', 'full')
      .execute();
    expect((await client.get('/admin/auth/me')).body).toEqual(ended('idle'));
    expect((await client.get('/admin/admins')).body).toEqual(ended('idle'));
  });

  it('checking /me does not count as activity; a real view does', async () => {
    const admin = await createAdmin('super_admin', 'sa@example.test');
    const client = await loginFully(admin);
    const twentyMinutesAgo = new Date(Date.now() - 20 * MINUTE);
    const setLastSeen = () =>
      db
        .updateTable('admin_sessions')
        .set({ last_seen_at: twentyMinutesAgo })
        .where('stage', '=', 'full')
        .execute();
    const lastSeen = async () =>
      (
        await db
          .selectFrom('admin_sessions')
          .select('last_seen_at')
          .where('stage', '=', 'full')
          .where('ended_at', 'is', null)
          .executeTakeFirstOrThrow()
      ).last_seen_at.getTime();

    await setLastSeen();
    expect((await client.get('/admin/auth/me')).status).toBe(200);
    expect(await lastSeen()).toBe(twentyMinutesAgo.getTime());

    await client.get('/admin/admins');
    expect(await lastSeen()).toBeGreaterThan(Date.now() - MINUTE);
  });

  it('12 hours after login: expired', async () => {
    const admin = await createAdmin('super_admin', 'sa@example.test');
    const client = await loginFully(admin);
    await db
      .updateTable('admin_sessions')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('stage', '=', 'full')
      .execute();
    expect((await client.get('/admin/auth/me')).body).toEqual(ended('expired'));
  });

  it('logout, a disabled account, or an unknown cookie: only "ended", nothing more', async () => {
    const admin = await createAdmin('super_admin', 'sa@example.test');
    const loggedOut = await loginFully(admin);
    const cookie = loggedOut.cookie;
    await loggedOut.post('/admin/auth/logout');
    const reused = new Client();
    reused.cookie = cookie;
    expect((await reused.get('/admin/auth/me')).body).toEqual(ended('ended'));

    const disabled = await loginFully(admin);
    await db.updateTable('admins').set({ status: 'disabled' }).execute();
    const body = (await disabled.get('/admin/auth/me')).body as object;
    expect(body).toEqual(ended('ended'));
    expect(JSON.stringify(body)).not.toMatch(/disabled|locked/i);

    const unknown = new Client();
    unknown.cookie = '__Host-sr_admin=not-a-real-token';
    expect((await unknown.get('/admin/auth/me')).body).toEqual(ended('ended'));
  });

  it('a half-finished login says which step comes next; once timed out it is just "ended"', async () => {
    const admin = await createAdmin('super_admin', 'sa@example.test');
    const client = new Client();
    await client.post('/admin/auth/login', { email: admin.email, password: admin.password });
    expect((await client.get('/admin/auth/me')).body).toEqual(
      ended('login_incomplete', { next: 'verify_2fa' }),
    );

    await db
      .updateTable('admin_sessions')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .execute();
    expect((await client.get('/admin/auth/me')).body).toEqual(ended('ended'));
  });
});

describe('roles (checked on the server)', () => {
  it('a Support Admin cannot open the Admin Team, and the attempt is logged', async () => {
    await createAdmin('super_admin', 'sa@example.test');
    const support = await createAdmin('support_admin', 'support@example.test');
    const client = await loginFully(support);
    expect((await client.get('/admin/admins')).status).toBe(403);
    expect((await auditRows()).at(-1)).toMatchObject({
      action: 'auth.access_denied',
      admin_id: support.id,
      reason: 'GET /admin/admins',
    });
  });

  it('a Super Admin can open the Admin Team (no secrets in the list)', async () => {
    const admin = await createAdmin('super_admin', 'sa@example.test');
    const res = await (await loginFully(admin)).get('/admin/admins');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        email: 'sa@example.test',
        role: 'super_admin',
        twoStepEnabled: true,
      }),
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/password|totp_secret/);
  });
});

describe('reset of a Support Admin’s 2-step setup', () => {
  const reason = 'Lost phone, confirmed by call';

  it('a Super Admin resets it; the Support Admin is logged out and sets it up again', async () => {
    const sa = await createAdmin('super_admin', 'sa@example.test');
    const support = await createAdmin('support_admin', 'support@example.test');
    const supportClient = await loginFully(support);
    const saClient = await loginFully(sa);

    const res = await saClient.post(`/admin/admins/${support.id}/reset-2fa`, { reason });
    expect(res.status).toBe(204);
    expect((await supportClient.get('/admin/auth/me')).status).toBe(401);

    const again = await new Client().post('/admin/auth/login', {
      email: support.email,
      password: support.password,
    });
    expect(again.body).toEqual({ next: 'setup_2fa' });
    expect((await auditRows()).find((r) => r.action === 'admin.2fa_reset')).toMatchObject({
      admin_id: sa.id,
      target_id: support.id,
      reason,
    });
  });

  it('refuses without a written reason, for a Super Admin, for oneself, and for a Support Admin', async () => {
    const sa = await createAdmin('super_admin', 'sa@example.test');
    const sa2 = await createAdmin('super_admin', 'sa2@example.test');
    const support = await createAdmin('support_admin', 'support@example.test');
    const saClient = await loginFully(sa);
    const supportClient = await loginFully(support);

    expect((await saClient.post(`/admin/admins/${support.id}/reset-2fa`, {})).status).toBe(400);
    expect((await saClient.post(`/admin/admins/${sa2.id}/reset-2fa`, { reason })).status).toBe(403);
    expect((await saClient.post(`/admin/admins/${sa.id}/reset-2fa`, { reason })).status).toBe(400);
    expect(
      (await supportClient.post(`/admin/admins/${support.id}/reset-2fa`, { reason })).status,
    ).toBe(403);
  });
});

describe('break-glass --reissue', () => {
  it('clears 2-step, ends every session, and the next login sets everything up again', async () => {
    const sa = await createAdmin('super_admin', 'sa@example.test');
    const client = await loginFully(sa);

    const issued = await reissueSuperAdminPassword(db, { email: sa.email });
    expect((await client.get('/admin/auth/me')).status).toBe(401);
    expect(await db.selectFrom('admin_backup_codes').selectAll().execute()).toEqual([]);

    const fresh = new Client();
    const login = await fresh.post('/admin/auth/login', {
      email: sa.email,
      password: issued.temporaryPassword,
    });
    expect(login.body).toEqual({ next: 'change_password' });
    const changed = await fresh.post('/admin/auth/password', {
      newPassword: 'river-mango-lantern-42',
    });
    expect(changed.body).toEqual({ next: 'setup_2fa' });
    expect(
      (await auditRows()).find((r) => r.action === 'setup.super_admin_reissued')?.reason,
    ).toMatch(/2-step setup cleared; all sessions ended/);
  });
});

describe('cross-site protection', () => {
  it('refuses a state change from another origin, or with no origin', async () => {
    const evil = await new Client('https://evil.example').post('/admin/auth/login', {
      email: 'a',
      password: 'b',
    });
    const none = await new Client(null).post('/admin/auth/login', { email: 'a', password: 'b' });
    expect([evil.status, none.status]).toEqual([403, 403]);
  });

  it('refuses a body that is not JSON', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/admin/auth/login')
      .set('Origin', env.ADMIN_PANEL_ORIGIN)
      .type('form')
      .send('email=a&password=b');
    expect(res.status).toBe(415);
  });

  it('CORS allows only the admin panel origin, with credentials', async () => {
    const preflight = (origin: string) =>
      request(app.getHttpServer() as App)
        .options('/admin/auth/login')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST');

    const panel = await preflight(env.ADMIN_PANEL_ORIGIN);
    expect(panel.headers['access-control-allow-origin']).toBe(env.ADMIN_PANEL_ORIGIN);
    expect(panel.headers['access-control-allow-credentials']).toBe('true');

    const other = await preflight('https://evil.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('audit volume', () => {
  it('logs a view once per session per short window, and never logs /me', async () => {
    const admin = await createAdmin('super_admin', 'sa@example.test');
    const client = await loginFully(admin);
    const views = async () => (await auditRows()).filter((r) => r.action === 'GET /admin/admins');

    await client.get('/admin/auth/me');
    await client.get('/admin/admins');
    await client.get('/admin/admins');
    await client.get('/admin/auth/me');
    expect(await views()).toHaveLength(1);
    expect((await views())[0]).toMatchObject({ admin_id: admin.id, status_code: 200 });
    expect((await auditActions()).some((a) => a.includes('/me'))).toBe(false);

    // A different view (other query) is logged.
    await client.get('/admin/admins?page=2');
    expect(await views()).toHaveLength(2);

    // Another session is logged separately.
    await (await loginFully(admin)).get('/admin/admins');
    expect(await views()).toHaveLength(3);

    // After the window (its Redis keys removed here) the same view is logged again.
    await redis.flushdb();
    await client.get('/admin/admins');
    expect(await views()).toHaveLength(4);
  });
});
