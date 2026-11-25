/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import type { Kysely } from 'kysely';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { configureApp } from '../src/app-setup';
import { AppModule } from '../src/app.module';
import { FakePhoneTokenVerifier } from '../src/app/auth/phone-token-verifier';
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

type Res = Omit<Response, 'body'> & { body: Record<string, any> };
const server = () => request(app.getHttpServer() as App);

async function admin(role: 'super_admin' | 'support_admin') {
  const email = `${role}@example.test`;
  await db
    .insertInto('admins')
    .values({
      name: role === 'super_admin' ? 'Asha' : 'Ravi',
      email,
      role,
      password_hash: await hashPassword(PASSWORD),
    })
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
    post: (path: string, body: object = {}): Promise<Res> =>
      server()
        .post(path)
        .set('Origin', env.ADMIN_PANEL_ORIGIN)
        .set('Cookie', cookie)
        .send(body)
        .then((r) => r as Res),
  };
}

/** A user reports a problem from the app ("Report a problem"). */
async function reportProblem(phone = '+919812344521') {
  const login = await server()
    .post('/v1/auth/firebase')
    .send({ firebaseIdToken: FakePhoneTokenVerifier.token(phone) })
    .expect(200);
  const auth = { Authorization: `Bearer ${login.body.token as string}` };
  await server().post('/v1/me/consent').set(auth).send({ version: '2026-10' }).expect(200);
  await db
    .updateTable('users')
    .set({ name: 'Priya Sharma' })
    .where('id', '=', login.body.user.id)
    .execute();
  await server()
    .post('/v1/support-tickets')
    .set(auth)
    .send({
      category: 'otp',
      message: 'The OTP never arrives on my phone.',
      appVersion: '1.1.5 (13)',
      deviceModel: 'CPH2381',
    })
    .expect(204);
}

describe('Admin Support Tickets', () => {
  it('lists tickets from the app with a masked phone, and shows one in full', async () => {
    await reportProblem();
    const a = await admin('support_admin');

    const list = await a.get('/admin/support-tickets');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    const t = list.body.items[0] as Record<string, any>;
    expect(t).toMatchObject({
      category: 'otp',
      status: 'open',
      userName: 'Priya Sharma',
      assignedTo: null,
    });
    expect(t.userPhone).toBe('+91 98•• ••4521'); // never the full number
    expect(JSON.stringify(list.body)).not.toContain('9812344521');
    expect(list.body.counts).toEqual({ open: 1 });

    const one = await a.get(`/admin/support-tickets/${t.id}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({
      message: 'The OTP never arrives on my phone.',
      appVersion: '1.1.5 (13)',
      deviceModel: 'CPH2381',
      user: { name: 'Priya Sharma', phone: '+91 98•• ••4521' },
    });
  });

  it('"Assign to me" takes a new ticket into In progress; Resolved records the time; filters work', async () => {
    await reportProblem();
    const a = await admin('support_admin');
    const id = (await a.get('/admin/support-tickets')).body.items[0].id as string;

    const taken = await a.post(`/admin/support-tickets/${id}/assign`, { toMe: true });
    expect(taken.status).toBe(200);
    expect(taken.body).toMatchObject({ status: 'in_progress', assignedTo: 'Ravi' });

    const resolved = await a.post(`/admin/support-tickets/${id}/status`, { status: 'closed' });
    expect(resolved.body.status).toBe('closed');
    expect(resolved.body.closedAt).not.toBeNull();
    expect((await a.get('/admin/support-tickets?status=open')).body.items).toHaveLength(0);
    expect((await a.get('/admin/support-tickets?status=closed')).body.items).toHaveLength(1);

    const reopened = await a.post(`/admin/support-tickets/${id}/status`, { status: 'open' });
    expect(reopened.body).toMatchObject({ status: 'open', closedAt: null });

    const unassigned = await a.post(`/admin/support-tickets/${id}/assign`, { toMe: false });
    expect(unassigned.body.assignedTo).toBeNull();
  });

  it('refuses a bad status, an unknown ticket and anyone not logged in as an admin', async () => {
    await reportProblem();
    const a = await admin('super_admin');
    const id = (await a.get('/admin/support-tickets')).body.items[0].id as string;
    expect(
      (await a.post(`/admin/support-tickets/${id}/status`, { status: 'deleted' })).status,
    ).toBe(400);
    expect(
      (await a.get('/admin/support-tickets/00000000-0000-4000-8000-000000000000')).status,
    ).toBe(404);
    expect((await a.get('/admin/support-tickets/not-a-uuid')).status).toBe(404);
    expect((await server().get('/admin/support-tickets')).status).toBe(401);
  });

  it('writes every view and change to the audit log', async () => {
    await reportProblem();
    const a = await admin('support_admin');
    const id = (await a.get('/admin/support-tickets')).body.items[0].id as string;
    await a.get(`/admin/support-tickets/${id}`);
    await a.post(`/admin/support-tickets/${id}/assign`, { toMe: true });
    await a.post(`/admin/support-tickets/${id}/status`, { status: 'closed' });
    const actions = (await db.selectFrom('audit_log').select('action').execute()).map(
      (r) => r.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'GET /admin/support-tickets',
        'GET /admin/support-tickets/:id',
        'POST /admin/support-tickets/:id/assign',
        'POST /admin/support-tickets/:id/status',
      ]),
    );
  });
});
