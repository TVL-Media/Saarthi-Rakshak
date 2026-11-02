import { Controller, Get, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import type { Kysely } from 'kysely';
import type { LoginReply, Me } from '@sarthi/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApp } from '../src/app-setup';
import { AppModule } from '../src/app.module';
import { LOGIN_LIMIT_PER_IP } from '../src/app/auth/app-auth.controller';
import { FakePhoneTokenVerifier } from '../src/app/auth/phone-token-verifier';
import { hashToken } from '../src/app/auth/user-sessions.service';
import { activeConnections, validateEnv } from '../src/config/env.schema';
import type { Database } from '../src/database/types';
import { openTestDatabase, resetTestDatabase } from './test-database';

let app: INestApplication;
let db: Kysely<Database>;
let redis: Redis;

const PHONE = '+919812344521';

/** A normal /app route (needs login and consent), only in these tests. */
@Controller('v1')
class ProbeController {
  @Get('test-probe')
  probe() {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

beforeAll(async () => {
  db = await openTestDatabase();
  const env = validateEnv(process.env);
  redis = new Redis(activeConnections(env).redisUrl);
  app = (
    await Test.createTestingModule({ imports: [AppModule, ProbeModule] }).compile()
  ).createNestApplication();
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

const http = () => request(app.getHttpServer() as App);

function login(phone = PHONE) {
  return http()
    .post('/v1/auth/firebase')
    .send({ firebaseIdToken: FakePhoneTokenVerifier.token(phone) });
}

async function loggedIn(phone = PHONE): Promise<string> {
  const res = await login(phone).expect(200);
  return (res.body as { token: string }).token;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('POST /v1/auth/firebase', () => {
  it('creates the user on first login and returns a token', async () => {
    const res = await login().expect(200);
    expect(res.body).toEqual({
      token: expect.any(String) as unknown,
      isNewUser: true,
      user: {
        id: expect.any(String) as unknown,
        name: null,
        phone: PHONE,
        bloodGroup: null,
        photoUrl: null,
        consentGiven: false,
        guardiansCount: 0,
        acceptedGuardiansCount: 0,
        rules: expect.objectContaining({ 'sos.countdown_seconds': 5 }) as unknown,
      },
    });
    const users = await db.selectFrom('users').select('phone').execute();
    expect(users).toEqual([{ phone: PHONE }]);
  });

  it('finds the same user on the next login', async () => {
    const first = await login().expect(200);
    const second = await login().expect(200);
    expect((second.body as LoginReply).isNewUser).toBe(false);
    expect((second.body as LoginReply).user.id).toBe((first.body as LoginReply).user.id);
  });

  it('stores only a hash of the token', async () => {
    const token = await loggedIn();
    const sessions = await db.selectFrom('user_sessions').select('token_hash').execute();
    expect(sessions).toEqual([{ token_hash: hashToken(token) }]);
    expect(JSON.stringify(sessions)).not.toContain(token);
  });

  it('logs out the old phone when the user logs in again (one phone at a time)', async () => {
    const oldToken = await loggedIn();
    const newToken = await loggedIn();
    await http().get('/v1/me').set(bearer(oldToken)).expect(401);
    await http().get('/v1/me').set(bearer(newToken)).expect(200);
    const ended = await db
      .selectFrom('user_sessions')
      .select('end_reason')
      .where('ended_at', 'is not', null)
      .execute();
    expect(ended).toEqual([{ end_reason: 'new_login' }]);
  });

  it('does not use the old admin "blocked" status (blocking is removed for now)', async () => {
    await loggedIn();
    await db.updateTable('users').set({ status: 'blocked' }).execute();
    await login().expect(200);
  });

  it('refuses a bad token with not_logged_in', async () => {
    const res = await http()
      .post('/v1/auth/firebase')
      .send({ firebaseIdToken: 'not-a-real-firebase-token' })
      .expect(401);
    expect(res.body).toEqual({ error: 'not_logged_in', message: expect.any(String) as unknown });
  });

  it('refuses a number that is not an Indian mobile', async () => {
    const res = await login('+14155550123').expect(400);
    expect((res.body as { error?: string }).error).toBe('invalid_input');
    expect(await db.selectFrom('users').select('id').execute()).toEqual([]);
  });

  it('refuses a missing token with invalid_input and the field name', async () => {
    const res = await http().post('/v1/auth/firebase').send({}).expect(400);
    expect(res.body).toEqual({
      error: 'invalid_input',
      message: expect.stringContaining('firebaseIdToken') as unknown,
    });
  });

  it(`allows ${LOGIN_LIMIT_PER_IP} tries per IP in 15 minutes`, async () => {
    for (let i = 0; i < LOGIN_LIMIT_PER_IP; i++) await login().expect(200);
    const res = await login().expect(429);
    expect((res.body as { error?: string }).error).toBe('too_many_requests');
  });
});

describe('Login check on /app routes', () => {
  it('refuses a request without a token', async () => {
    const res = await http().get('/v1/me').expect(401);
    expect(res.body).toEqual({ error: 'not_logged_in', message: 'Please log in again.' });
  });

  it('refuses an unknown token', async () => {
    await http()
      .get('/v1/me')
      .set(bearer('x'.repeat(43)))
      .expect(401);
  });

  it('refuses an expired session', async () => {
    const token = await loggedIn();
    await db
      .updateTable('user_sessions')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .execute();
    await http().get('/v1/me').set(bearer(token)).expect(401);
  });

  it('moves the expiry forward when the app is used (90 days from last use)', async () => {
    const token = await loggedIn();
    const soon = new Date(Date.now() + 60_000);
    await db
      .updateTable('user_sessions')
      .set({ expires_at: soon, last_seen_at: new Date(Date.now() - 5 * 60_000) })
      .execute();
    await http().get('/v1/me').set(bearer(token)).expect(200);
    const { expires_at } = await db
      .selectFrom('user_sessions')
      .select('expires_at')
      .executeTakeFirstOrThrow();
    expect(expires_at.getTime()).toBeGreaterThan(Date.now() + 89 * 24 * 3600_000);
  });

  it('answers unknown /app addresses with not_found in the app error shape', async () => {
    const token = await loggedIn();
    const res = await http().get('/v1/nothing-here').set(bearer(token)).expect(404);
    expect(res.body).toEqual({ error: 'not_found', message: 'Not found.' });
  });

  it('does not change error replies outside /app', async () => {
    const res = await http().get('/admin/auth/me').expect(401);
    expect((res.body as { error?: string }).error).toBeUndefined();
    expect((res.body as { reason?: string }).reason).toBe('no_session');
  });
});

describe('Consent', () => {
  it('blocks other features until the terms are accepted', async () => {
    const token = await loggedIn();
    const res = await http().get('/v1/test-probe').set(bearer(token)).expect(403);
    expect((res.body as { error?: string }).error).toBe('consent_required');
    await http().post('/v1/me/consent').set(bearer(token)).send({ version: '2026-10' }).expect(200);
    await http().get('/v1/test-probe').set(bearer(token)).expect(200);
  });

  it('records consent with the version', async () => {
    const token = await loggedIn();
    const res = await http()
      .post('/v1/me/consent')
      .set(bearer(token))
      .send({ version: '2026-10' })
      .expect(200);
    expect((res.body as Me).consentGiven).toBe(true);
    const user = await db
      .selectFrom('users')
      .select(['consent_at', 'consent_version'])
      .executeTakeFirstOrThrow();
    expect(user.consent_at).toBeInstanceOf(Date);
    expect(user.consent_version).toBe('2026-10');
  });

  it('refuses an empty version', async () => {
    const token = await loggedIn();
    await http().post('/v1/me/consent').set(bearer(token)).send({ version: '' }).expect(400);
  });
});

describe('GET /v1/me and logout', () => {
  it('counts guardians who have not declined', async () => {
    const token = await loggedIn();
    const { id } = await db.selectFrom('users').select('id').executeTakeFirstOrThrow();
    await db
      .insertInto('guardians')
      .values([
        { user_id: id, name: 'A', phone: '+919800000001', invite_status: 'accepted' },
        { user_id: id, name: 'B', phone: '+919800000002', invite_status: 'pending' },
        { user_id: id, name: 'C', phone: null, invite_status: 'declined' },
      ])
      .execute();
    const res = await http().get('/v1/me').set(bearer(token)).expect(200);
    expect((res.body as Me).guardiansCount).toBe(2);
  });

  it('ends the session on logout', async () => {
    const token = await loggedIn();
    await http().post('/v1/auth/logout').set(bearer(token)).expect(204);
    await http().get('/v1/me').set(bearer(token)).expect(401);
    const { end_reason } = await db
      .selectFrom('user_sessions')
      .select('end_reason')
      .executeTakeFirstOrThrow();
    expect(end_reason).toBe('logout');
  });
});
