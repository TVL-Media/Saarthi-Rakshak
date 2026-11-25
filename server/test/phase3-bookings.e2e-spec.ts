/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { sql, type Kysely } from 'kysely';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { OutgoingMessages } from '../src/app/messages/outgoing-messages';
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
    post: (path: string, body: object = {}): Promise<Res> =>
      server()
        .post(path)
        .set('Origin', env.ADMIN_PANEL_ORIGIN)
        .set('Cookie', cookie)
        .send(body)
        .then((r) => r as Res),
  };
}

/** A signed-in app user (the test phone-token verifier accepts a made-up token). */
async function appUser(phone = '+919812344521') {
  const login = await server()
    .post('/v1/auth/firebase')
    .send({ firebaseIdToken: FakePhoneTokenVerifier.token(phone) })
    .expect(200);
  const token = login.body.token as string;
  const userId = login.body.user.id as string;
  await server()
    .post('/v1/me/consent')
    .set({ Authorization: `Bearer ${token}` })
    .send({ version: '2026-10' })
    .expect(200);
  await db.updateTable('users').set({ name: 'Priya Sharma' }).where('id', '=', userId).execute();
  const auth = { Authorization: `Bearer ${token}` };
  return {
    userId,
    get: (path: string): Promise<Res> =>
      server()
        .get(path)
        .set(auth)
        .then((r) => r as Res),
    post: (path: string, body: object = {}): Promise<Res> =>
      server()
        .post(path)
        .set(auth)
        .send(body)
        .then((r) => r as Res),
  };
}

const switchOn = async (...keys: string[]) => {
  for (const key of keys) {
    await db
      .insertInto('settings')
      .values({ key, value: 1 })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: 1 }))
      .execute();
  }
};

const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();
const inThreeHours = () => new Date(Date.now() + 3 * 3600_000).toISOString();
const bookingBody = (id = randomUUID()) => ({
  id,
  serviceType: 'home_guard',
  windowStart: inAnHour(),
  windowEnd: inThreeHours(),
  place: { lat: 28.5707, lng: 77.3219, label: 'Sector 18' },
  notes: 'Ring the bell twice',
});

/** An approved Rakshak, optionally online at a position. */
async function rakshak(
  name: string,
  at?: { lat: number; lng: number; minutesAgo?: number; online?: boolean },
) {
  const { id } = await db
    .insertInto('users')
    .values({ phone: `+9170000${Math.floor(10000 + Math.random() * 89999)}`, name })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('rakshak_applications')
    .values({
      user_id: id,
      locked_details: 'locked',
      area: 'Sector 18',
      id_type: 'aadhaar',
      id_last4: '1234',
      consent_at: new Date(),
      status: 'approved',
    })
    .execute();
  if (at) {
    await db
      .insertInto('rakshak_presence')
      .values({
        user_id: id,
        location: sql<string>`ST_SetSRID(ST_MakePoint(${at.lng}, ${at.lat}), 4326)::geography`,
        online: at.online ?? true,
        updated_at: new Date(Date.now() - (at.minutesAgo ?? 0) * 60_000),
      })
      .execute();
  }
  return id;
}

describe('Phase 3: switched off by default', () => {
  it('says "not found" (the app shows "Not available yet") until the switches are on', async () => {
    const u = await appUser();
    expect((await u.get('/v1/booking/services')).status).toBe(404);
    expect((await u.get('/v1/bookings')).status).toBe(404);
    expect((await u.post('/v1/bookings', bookingBody())).status).toBe(404);
    expect((await u.get('/v1/rakshaks/nearby?lat=28.57&lng=77.32')).status).toBe(404);
    const me = await u.get('/v1/me');
    expect(me.body.rules['feature.bookings']).toBe(0);
    expect(me.body.rules['feature.nearby']).toBe(0);
  });
});

describe('Phase 3: customer bookings', () => {
  beforeEach(async () => {
    await switchOn('feature.bookings', 'feature.nearby');
  });

  it('lists the four services and tells the app the switches are on', async () => {
    const u = await appUser();
    const services = await u.get('/v1/booking/services');
    expect(services.status).toBe(200);
    expect((services.body as unknown as { id: string }[]).map((s) => s.id)).toEqual([
      'pre_booking',
      'invisible_rakshak',
      'home_guard',
      'senior_visit',
    ]);
    expect((await u.get('/v1/me')).body.rules['feature.bookings']).toBe(1);
  });

  it('creates a booking once however many times the phone repeats it', async () => {
    const u = await appUser();
    const body = bookingBody();
    const first = await u.post('/v1/bookings', body);
    const again = await u.post('/v1/bookings', body);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(first.body).toMatchObject({
      status: 'requested',
      serviceName: 'Home Guard',
      place: { label: 'Sector 18' },
      canCancel: true,
      matching: { state: 'searching' },
    });
    expect(first.body.history).toHaveLength(1);
    expect((await u.get('/v1/bookings')).body).toHaveLength(1);
    const count = await db
      .selectFrom('booking_events')
      .select(sql<string>`count(*)`.as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(1);
  });

  it('keeps one user from reading or using another user’s booking', async () => {
    const a = await appUser('+919812344521');
    const b = await appUser('+919812344522');
    const body = bookingBody();
    await a.post('/v1/bookings', body);
    expect((await b.get(`/v1/bookings/${body.id}`)).status).toBe(404);
    expect((await b.post(`/v1/bookings/${body.id}/cancel`)).status).toBe(404);
    expect((await b.post('/v1/bookings', body)).status).toBe(404);
    expect((await b.get('/v1/bookings')).body).toHaveLength(0);
  });

  it('rejects an unknown service, a window that ends before it starts, and a window in the past', async () => {
    const u = await appUser();
    expect((await u.post('/v1/bookings', { ...bookingBody(), serviceType: 'nope' })).status).toBe(
      400,
    );
    expect(
      (
        await u.post('/v1/bookings', {
          ...bookingBody(),
          windowStart: inThreeHours(),
          windowEnd: inAnHour(),
        })
      ).status,
    ).toBe(400);
    const past = new Date(Date.now() - 3600_000).toISOString();
    const earlier = new Date(Date.now() - 7200_000).toISOString();
    expect(
      (await u.post('/v1/bookings', { ...bookingBody(), windowStart: earlier, windowEnd: past }))
        .status,
    ).toBe(400);
  });

  it('stops at five open bookings', async () => {
    const u = await appUser();
    for (let i = 0; i < 5; i++)
      expect((await u.post('/v1/bookings', bookingBody())).status).toBe(200);
    const sixth = await u.post('/v1/bookings', bookingBody());
    expect(sixth.status).toBe(409);
    expect(sixth.body.error).toBe('limit_reached');
  });

  it('lets the user cancel (and repeat it), but not after it is completed', async () => {
    const u = await appUser();
    const body = bookingBody();
    await u.post('/v1/bookings', body);
    const cancelled = await u.post(`/v1/bookings/${body.id}/cancel`, { reason: 'Plans changed' });
    expect(cancelled.body).toMatchObject({ status: 'cancelled', canCancel: false });
    expect((await u.post(`/v1/bookings/${body.id}/cancel`)).body.status).toBe('cancelled');
    expect((cancelled.body.history as { status: string }[]).map((h) => h.status)).toEqual([
      'requested',
      'cancelled',
    ]);

    const done = bookingBody();
    await u.post('/v1/bookings', done);
    await db
      .updateTable('bookings')
      .set({ status: 'completed' })
      .where('id', '=', done.id)
      .execute();
    expect((await u.post(`/v1/bookings/${done.id}/cancel`)).status).toBe(409);
  });
});

describe('Phase 3: admin works a booking from request to completion', () => {
  beforeEach(async () => {
    await switchOn('feature.bookings', 'feature.nearby');
  });

  it('quote → accept → assign → started → completed, with every step in the history and a push each time', async () => {
    const u = await appUser();
    const body = bookingBody();
    await u.post('/v1/bookings', body);
    const support = await admin('support_admin');
    const boss = await admin('super_admin');

    // The list masks the phone and never carries coordinates.
    const list = await support.get('/admin/bookings?status=requested');
    expect(list.status).toBe(200);
    expect(list.body.counts).toEqual({ requested: 1 });
    expect(list.body.items[0]).toMatchObject({
      id: body.id,
      serviceName: 'Home Guard',
      placeLabel: 'Sector 18',
    });
    expect(list.body.items[0].userPhone).toBe('+91 98•• ••4521');
    expect(JSON.stringify(list.body)).not.toMatch(/9812344521|28\.57|77\.32/);

    // Only a Super Admin sends a quote.
    expect(
      (await support.post(`/admin/bookings/${body.id}/quote`, { amountPaise: 49950 })).status,
    ).toBe(403);
    const quoted = await boss.post(`/admin/bookings/${body.id}/quote`, {
      amountPaise: 49950,
      note: 'Two hours',
    });
    expect(quoted.status).toBe(200);
    expect(quoted.body).toMatchObject({ status: 'quoted', placeLabel: 'Sector 18' });
    expect(quoted.body.place).toBeUndefined();
    expect(quoted.body.user.phone).toBe('+91 98•• ••4521');

    const asUser = await u.get(`/v1/bookings/${body.id}`);
    expect(asUser.body).toMatchObject({
      status: 'quoted',
      quote: { amountPaise: 49950, note: 'Two hours' },
    });

    expect((await u.post(`/v1/bookings/${body.id}/quote/accept`)).body.status).toBe('confirmed');
    expect((await u.post(`/v1/bookings/${body.id}/quote/accept`)).body.status).toBe('confirmed');

    // Assigning needs an approved Rakshak.
    const stranger = (
      await db
        .insertInto('users')
        .values({ phone: '+917000000001', name: 'Not Approved' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    expect(
      (await support.post(`/admin/bookings/${body.id}/assign`, { rakshakUserId: stranger })).status,
    ).toBe(409);
    const asha = await rakshak('Asha Verma');
    const options = await support.get('/admin/bookings/rakshaks');
    expect(options.body.items).toEqual([
      { userId: asha, firstName: 'Asha', area: 'Sector 18', online: false },
    ]);
    const assigned = await support.post(`/admin/bookings/${body.id}/assign`, {
      rakshakUserId: asha,
    });
    expect(assigned.body).toMatchObject({ status: 'assigned', rakshak: { firstName: 'Asha' } });
    expect((await u.get(`/v1/bookings/${body.id}`)).body.rakshak).toEqual({
      firstName: 'Asha',
      etaMinutes: null,
    });

    expect(
      (await support.post(`/admin/bookings/${body.id}/status`, { status: 'in_progress' })).body
        .status,
    ).toBe('in_progress');
    const done = await support.post(`/admin/bookings/${body.id}/status`, { status: 'completed' });
    expect(done.body.status).toBe('completed');
    expect(
      (done.body.history as { status: string; by: string }[]).map((h) => `${h.status}:${h.by}`),
    ).toEqual([
      'requested:user',
      'quoted:admin',
      'confirmed:user',
      'assigned:admin',
      'in_progress:admin',
      'completed:admin',
    ]);

    // A completed booking cannot be cancelled or moved again.
    expect(
      (await support.post(`/admin/bookings/${body.id}/cancel`, { reason: 'Too late to cancel' }))
        .status,
    ).toBe(409);
    expect(
      (await support.post(`/admin/bookings/${body.id}/status`, { status: 'in_progress' })).status,
    ).toBe(409);

    const pushed = app.get(OutgoingMessages).pushed.filter((p) => p.type === 'booking_status');
    expect(pushed.map((p) => p.data.status)).toEqual([
      'quoted',
      'assigned',
      'in_progress',
      'completed',
    ]);
    expect(pushed.every((p) => p.userId === u.userId && p.data.bookingId === body.id)).toBe(true);

    // Every admin view and action is in the audit log.
    const audit = await db.selectFrom('audit_log').select('action').execute();
    const actions = audit.map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'GET /admin/bookings',
        'POST /admin/bookings/:id/quote',
        'POST /admin/bookings/:id/assign',
        'POST /admin/bookings/:id/status',
      ]),
    );
  });

  it('cancels with a reason (required) and tells the user; the user can decline a quote', async () => {
    const u = await appUser();
    const body = bookingBody();
    await u.post('/v1/bookings', body);
    const support = await admin('support_admin');
    expect((await support.post(`/admin/bookings/${body.id}/cancel`, { reason: 'no' })).status).toBe(
      400,
    );
    const res = await support.post(`/admin/bookings/${body.id}/cancel`, {
      reason: 'No Rakshak free then',
    });
    expect(res.body).toMatchObject({ status: 'cancelled', cancelReason: 'No Rakshak free then' });
    expect((await u.get(`/v1/bookings/${body.id}`)).body.status).toBe('cancelled');

    const other = bookingBody();
    await u.post('/v1/bookings', other);
    const boss = await admin('super_admin');
    await boss.post(`/admin/bookings/${other.id}/quote`, { amountPaise: 10000 });
    const declined = await u.post(`/v1/bookings/${other.id}/quote/decline`);
    expect(declined.body).toMatchObject({ status: 'cancelled' });
  });

  it('refuses an expired quote', async () => {
    const u = await appUser();
    const body = bookingBody();
    await u.post('/v1/bookings', body);
    const boss = await admin('super_admin');
    await boss.post(`/admin/bookings/${body.id}/quote`, {
      amountPaise: 20000,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect((await u.post(`/v1/bookings/${body.id}/quote/accept`)).status).toBe(409);
  });

  it('shows an empty list and 404 for an unknown booking, and is closed to the signed-out', async () => {
    const support = await admin('support_admin');
    const list = await support.get('/admin/bookings');
    expect(list.body).toEqual({ items: [], more: false, counts: {} });
    expect((await support.get(`/admin/bookings/${randomUUID()}`)).status).toBe(404);
    expect((await server().get('/admin/bookings')).status).toBe(401);
  });
});

describe('Phase 3: Rakshaks near me', () => {
  beforeEach(async () => {
    await switchOn('feature.nearby');
  });

  it('is empty until a Rakshak is online, then shows only fresh, online, approved Rakshaks in range', async () => {
    const u = await appUser();
    const empty = await u.get('/v1/rakshaks/nearby?lat=28.5707&lng=77.3219&radiusM=2000');
    expect(empty.body).toEqual({ items: [], refreshSeconds: 30, maxRadiusM: 5000 });

    const near = await rakshak('Asha Verma', { lat: 28.5757, lng: 77.3219 }); // about 550 m
    await rakshak('Far Away', { lat: 28.7, lng: 77.5 });
    await rakshak('Offline One', { lat: 28.572, lng: 77.322, online: false });
    await rakshak('Stale One', { lat: 28.572, lng: 77.322, minutesAgo: 30 });
    // Online and close, but never approved: must not appear.
    const unapproved = (
      await db
        .insertInto('users')
        .values({ phone: '+917000000002', name: 'Nope' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('rakshak_presence')
      .values({
        user_id: unapproved,
        location: sql<string>`ST_SetSRID(ST_MakePoint(77.3219, 28.5710), 4326)::geography`,
        online: true,
      })
      .execute();

    const res = await u.get('/v1/rakshaks/nearby?lat=28.5707&lng=77.3219&radiusM=2000');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id: near, firstName: 'Asha', etaMinutes: null });
    expect(res.body.items[0].distanceM).toBeGreaterThan(400);
    expect(res.body.items[0].distanceM).toBeLessThan(700);
    // An approximate position and no phone number.
    expect(res.body.items[0].lat).toBe(28.576);
    expect(JSON.stringify(res.body)).not.toContain('+9170');
  });

  it('rejects a radius above the limit', async () => {
    const u = await appUser();
    expect((await u.get('/v1/rakshaks/nearby?lat=28.57&lng=77.32&radiusM=9000')).status).toBe(400);
    expect((await u.get('/v1/rakshaks/nearby?lat=999&lng=77.32')).status).toBe(400);
  });
});
