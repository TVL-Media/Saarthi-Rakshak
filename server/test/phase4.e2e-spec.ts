/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import { sql, type Kysely } from 'kysely';
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
async function appUser(phone = '+919812344521', name = 'Priya Sharma') {
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
  await db.updateTable('users').set({ name }).where('id', '=', userId).execute();
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
    put: (path: string, body: object = {}): Promise<Res> =>
      server()
        .put(path)
        .set(auth)
        .send(body)
        .then((r) => r as Res),
    del: (path: string): Promise<Res> =>
      server()
        .delete(path)
        .set(auth)
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

const ALL = [
  'feature.night_mode',
  'feature.safe_places',
  'feature.women_safety',
  'feature.legal_support',
  'feature.child_safety',
];

describe('Phase 4 switches', () => {
  it('every Phase 4 endpoint says "Not available yet" while its switch is off', async () => {
    const u = await appUser();
    for (const path of [
      '/v1/night-mode',
      '/v1/safe-places?lat=28.57&lng=77.32',
      '/v1/guidance',
      '/v1/partners?kind=lawyer',
      '/v1/child/links',
    ]) {
      const res = await u.get(path);
      expect([path, res.status]).toEqual([path, 404]);
      expect(res.body.message).toBe('Not available yet.');
    }
  });
});

describe('Night Mode', () => {
  it('is saved per user and is only a flag', async () => {
    await switchOn('feature.night_mode');
    const u = await appUser();
    expect((await u.get('/v1/night-mode')).body.active).toBe(false);
    expect((await u.put('/v1/night-mode', { active: true })).body.active).toBe(true);
    expect((await u.get('/v1/night-mode')).body.active).toBe(true);
    expect((await u.put('/v1/night-mode', { active: false })).body.active).toBe(false);
    const other = await appUser('+919812300002', 'Anita');
    expect((await other.get('/v1/night-mode')).body.active).toBe(false);
  });
});

describe('Safe Place Finder', () => {
  async function partner(over: Record<string, unknown> = {}) {
    return db
      .insertInto('partners')
      .values({
        kind: 'safe_point',
        name: 'Sector 18 Help Desk',
        category: 'help_desk',
        location: sql<string>`ST_SetSRID(ST_MakePoint(77.3219, 28.5707), 4326)::geography`,
        status: 'approved',
        expires_at: new Date(Date.now() + 86_400_000),
        phone: '+911234567890',
        ...over,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  it('lists only approved, unexpired partner points with the badge; map places are off without a key', async () => {
    await switchOn('feature.safe_places');
    await partner();
    await partner({ name: 'Expired desk', expires_at: new Date(Date.now() - 1000) });
    await partner({ name: 'Unverified desk', status: 'submitted' });
    const u = await appUser();
    const res = await u.get('/v1/safe-places?lat=28.5707&lng=77.3219&radiusM=2000');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.name)).toEqual(['Sector 18 Help Desk']);
    expect(res.body.items[0]).toMatchObject({
      verified: true,
      source: 'partner',
      phone: '+911234567890',
    });
    expect(res.body.providerAvailable).toBe(false);
    expect(res.body.providerMessage).toContain('not switched on');
    expect(res.body.disclaimer).toContain('does not guarantee');
  });

  it('sorts by distance and filters by category', async () => {
    await switchOn('feature.safe_places');
    await partner({
      name: 'Far',
      category: 'help_desk',
      location: sql`ST_SetSRID(ST_MakePoint(77.3300, 28.5800), 4326)::geography`,
    });
    await partner({ name: 'Near', category: 'help_desk' });
    await partner({ name: 'Pharmacy', category: 'pharmacy' });
    const u = await appUser();
    const all = await u.get(
      '/v1/safe-places?lat=28.5707&lng=77.3219&category=partner&radiusM=5000',
    );
    expect(all.body.items.map((i: any) => i.name)).toEqual(['Near', 'Pharmacy', 'Far']);
    const one = await u.get(
      '/v1/safe-places?lat=28.5707&lng=77.3219&category=pharmacy&radiusM=5000',
    );
    expect(one.body.items.map((i: any) => i.name)).toEqual(['Pharmacy']);
  });
});

describe('Guidance', () => {
  it('shows only approved articles that are still in their review period', async () => {
    await switchOn('feature.women_safety');
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const add = (title: string, over: Record<string, unknown>) =>
      db
        .insertInto('guidance_articles')
        .values({
          situation: 'threat',
          title,
          steps: JSON.stringify(['Move to a public place']),
          ...over,
        } as never)
        .execute();
    await add('Current', { status: 'approved', reviewed_on: day(-10), review_due: day(20) });
    await add('Review passed', { status: 'approved', reviewed_on: day(-100), review_due: day(-1) });
    await add('Draft', { status: 'draft' });
    const u = await appUser();
    const res = await u.get('/v1/guidance?situation=threat');
    expect(res.body.items.map((i: any) => i.title)).toEqual(['Current']);
    expect(res.body.items[0].steps).toEqual(['Move to a public place']);
  });
});

describe('Support partners and requests', () => {
  async function lawyer(over: Record<string, unknown> = {}) {
    return db
      .insertInto('partners')
      .values({
        kind: 'lawyer',
        name: 'Adv. Rao',
        category: 'criminal',
        city: 'Noida',
        languages: ['en', 'hi'],
        status: 'approved',
        expires_at: new Date(Date.now() + 86_400_000),
        ...over,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  it('lists approved lawyers; a request gets a reference, a timeline, and admins move it on', async () => {
    await switchOn('feature.legal_support');
    const l = await lawyer();
    await lawyer({ name: 'Unapproved', status: 'submitted' });
    const u = await appUser();
    const list = await u.get('/v1/partners?kind=lawyer&language=hi');
    expect(list.body.items.map((i: any) => i.name)).toEqual(['Adv. Rao']);

    const id = randomUUID();
    const body = {
      id,
      kind: 'legal',
      partnerId: l.id,
      category: 'criminal',
      urgency: 'urgent',
      summary: 'I was falsely accused at work.',
    };
    const made = await u.post('/v1/partner-requests', body);
    expect(made.status).toBe(200);
    expect(made.body.reference).toMatch(/^SR-[A-Z0-9]{8}$/);
    expect(made.body.status).toBe('requested');
    // A repeat of the same request is the same request.
    const again = await u.post('/v1/partner-requests', body);
    expect(again.body.reference).toBe(made.body.reference);

    const su = await admin('super_admin');
    const queue = await su.get('/admin/phase4/requests');
    expect(queue.body.items).toHaveLength(1);
    expect(queue.body.items[0].userPhone).toContain('••');
    const moved = await su.post(`/admin/phase4/requests/${id}/status`, {
      status: 'contacted',
      message: 'The lawyer will call you today',
      internalNote: 'Needs Hindi speaker',
    });
    expect(moved.status).toBe(200);
    const mine = await u.get(`/v1/partner-requests/${id}`);
    expect(mine.body.status).toBe('contacted');
    expect(mine.body.timeline.map((t: any) => t.status)).toEqual(['requested', 'contacted']);
    // The internal note never reaches the user.
    expect(JSON.stringify(mine.body)).not.toContain('Hindi speaker');
    expect((await u.post(`/v1/partner-requests/${id}/close`)).body.status).toBe('closed');
  });

  it('refuses a partner that is not approved, and another user cannot read the request', async () => {
    await switchOn('feature.legal_support');
    const bad = await lawyer({ name: 'Unapproved', status: 'submitted' });
    const u = await appUser();
    const res = await u.post('/v1/partner-requests', {
      id: randomUUID(),
      kind: 'legal',
      partnerId: bad.id,
      category: 'criminal',
      summary: 'Please help me with a case.',
    });
    expect(res.status).toBe(400);
    const ok = randomUUID();
    await u.post('/v1/partner-requests', {
      id: ok,
      kind: 'legal',
      category: 'criminal',
      summary: 'Please help me with a case.',
    });
    const other = await appUser('+919812300003', 'Other');
    expect((await other.get(`/v1/partner-requests/${ok}`)).status).toBe(404);
  });
});

describe('Incident reports', () => {
  const report = (over: Record<string, unknown> = {}) => ({
    kind: 'workplace',
    category: 'intimidation',
    occurredAt: new Date().toISOString(),
    description: 'My manager threatened me in a meeting.',
    ...over,
  });

  it('keeps a draft editable, then a submitted report becomes a record; legal route creates a request', async () => {
    await switchOn('feature.legal_support');
    const u = await appUser();
    const id = randomUUID();
    const draft = await u.put(`/v1/incident-reports/${id}`, report());
    expect(draft.status).toBe(200);
    expect(draft.body.status).toBe('draft');
    expect(draft.body.route).toBe('private');
    const edited = await u.put(
      `/v1/incident-reports/${id}`,
      report({ description: 'My manager threatened me again.' }),
    );
    expect(edited.body.description).toContain('again');
    const sent = await u.put(
      `/v1/incident-reports/${id}`,
      report({ description: 'My manager threatened me again.', route: 'legal', submit: true }),
    );
    expect(sent.body.status).toBe('submitted');
    expect(sent.body.partnerRequestId).toBe(id);
    // A submitted report is never rewritten.
    const tried = await u.put(
      `/v1/incident-reports/${id}`,
      report({ description: 'Changed after sending, longer text' }),
    );
    expect(tried.body.description).toContain('again');
    expect((await u.post(`/v1/incident-reports/${id}/delete`)).status).toBe(409);
    expect((await u.get('/v1/partner-requests')).body.items).toHaveLength(1);
    // Admins see counts only.
    const su = await admin('super_admin');
    const overview = await su.get('/admin/phase4/overview');
    expect(overview.body.reports).toEqual([{ kind: 'workplace', status: 'submitted', count: 1 }]);
    expect(JSON.stringify(overview.body)).not.toContain('threatened');
  });

  it("needs the organisation named for an organisation route, and checks vault items are the user's own", async () => {
    await switchOn('feature.legal_support', 'feature.women_safety');
    const u = await appUser();
    const noOrg = await u.put(
      `/v1/incident-reports/${randomUUID()}`,
      report({ route: 'organisation' }),
    );
    expect(noOrg.status).toBe(400);
    const foreign = await u.put(
      `/v1/incident-reports/${randomUUID()}`,
      report({ evidenceItemIds: [randomUUID()] }),
    );
    expect(foreign.status).toBe(400);
    const women = await u.put(
      `/v1/incident-reports/${randomUUID()}`,
      report({ kind: 'harassment', category: 'stalking' }),
    );
    expect(women.status).toBe(200);
    expect((await u.get('/v1/incident-reports?group=women')).body.items).toHaveLength(1);
    expect((await u.get('/v1/incident-reports?group=men')).body.items).toHaveLength(0);
  });
});

describe('Admin partner lifecycle and guidance', () => {
  it('submit → verify → approve (Super Admin, with expiry) → expire; edits remove the badge', async () => {
    const su = await admin('super_admin');
    const support = await admin('support_admin');
    const made = await support.post('/admin/phase4/partners', {
      kind: 'safe_point',
      name: 'Metro Help Desk',
      category: 'help_desk',
      phone: '+91 120 1234567',
      lat: 28.57,
      lng: 77.32,
    });
    expect(made.status).toBe(200);
    expect(made.body.status).toBe('submitted');
    const id = made.body.id as string;
    expect(
      (await support.post(`/admin/phase4/partners/${id}/action`, { action: 'approve' })).status,
    ).toBe(404);
    expect(
      (await support.post(`/admin/phase4/partners/${id}/action`, { action: 'verify' })).body.status,
    ).toBe('verified');
    expect(
      (await support.post(`/admin/phase4/partners/${id}/action`, { action: 'approve' })).status,
    ).toBe(404);
    const approved = await su.post(`/admin/phase4/partners/${id}/action`, { action: 'approve' });
    expect(approved.body.status).toBe('approved');
    expect(approved.body.expiresAt).toBeTruthy();
    // Editing the details sends it back for checking.
    const edited = await su.post(`/admin/phase4/partners/${id}`, {
      kind: 'safe_point',
      name: 'Metro Help Desk 2',
      category: 'help_desk',
      lat: 28.57,
      lng: 77.32,
    });
    expect(edited.body.status).toBe('submitted');
    expect(
      (await su.post(`/admin/phase4/partners/${id}/action`, { action: 'expire' })).status,
    ).toBe(404); // reason needed
    const missingPoint = await su.post('/admin/phase4/partners', {
      kind: 'safe_point',
      name: 'No point',
      category: 'police',
    });
    expect(missingPoint.status).toBe(404);
  });

  it('guidance is draft until a Super Admin sets review dates; editing needs a new approval', async () => {
    const su = await admin('super_admin');
    const support = await admin('support_admin');
    await support.post('/admin/phase4/guidance', {
      situation: 'stalking',
      title: 'If you are followed',
      steps: ['Go to a busy place', 'Call 112'],
    });
    const list = await su.get('/admin/phase4/guidance');
    const id = list.body.items[0].id as string;
    expect(list.body.items[0].status).toBe('draft');
    expect(
      (
        await support.post(`/admin/phase4/guidance/${id}/approve`, {
          reviewedOn: '2026-11-01',
          reviewDue: '2027-11-01',
        })
      ).status,
    ).toBe(403);
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const ok = await su.post(`/admin/phase4/guidance/${id}/approve`, {
      reviewedOn: day(0),
      reviewDue: day(90),
    });
    expect(ok.body.items[0].status).toBe('approved');
    const re = await su.post(`/admin/phase4/guidance/${id}`, {
      situation: 'stalking',
      title: 'If you are followed (updated)',
      steps: ['Go to a busy place', 'Call 112'],
    });
    expect(re.body.items[0].status).toBe('draft');
  });
});

describe('Child Safety', () => {
  async function linkedPair() {
    await switchOn('feature.child_safety');
    const parent = await appUser('+919812300010', 'Meera Parent');
    const child = await appUser('+919812300011', 'Aarav');
    const linkId = randomUUID();
    const made = await parent.post('/v1/child/links', {
      id: linkId,
      childName: 'Aarav',
      childPhone: '+919812300011',
    });
    expect(made.status).toBe(200);
    expect(made.body.status).toBe('invited');
    const inv = await child.get('/v1/child/invitations');
    expect(inv.body.invitations).toHaveLength(1);
    const accepted = await child.post(`/v1/child/invitations/${linkId}/accept`);
    expect(accepted.body.status).toBe('active');
    return { parent, child, linkId };
  }

  it("links only through the child's own acceptance, and the parent becomes the child's Guardian", async () => {
    const { parent, child, linkId } = await linkedPair();
    const guardians = await db
      .selectFrom('guardians')
      .select(['phone', 'invite_status'])
      .where('user_id', '=', child.userId)
      .execute();
    expect(guardians).toEqual([{ phone: '+919812300010', invite_status: 'accepted' }]);
    // Somebody else cannot accept or manage the link.
    const stranger = await appUser('+919812300012', 'Stranger');
    expect((await stranger.post(`/v1/child/invitations/${linkId}/accept`)).status).toBe(404);
    expect((await stranger.get(`/v1/child/links/${linkId}/zones`)).status).toBe(404);
    // Revoking stops the link.
    expect((await parent.post(`/v1/child/links/${linkId}/revoke`)).body.status).toBe('revoked');
    expect(
      (
        await parent.put(`/v1/child/links/${linkId}/zones/${randomUUID()}`, {
          name: 'School',
          lat: 28.57,
          lng: 77.32,
          radiusM: 200,
        })
      ).status,
    ).toBe(409);
  });

  it('raises one entry and one exit alert for a zone, never on rough accuracy, and never on the first fix', async () => {
    const { parent, child, linkId } = await linkedPair();
    const zoneId = randomUUID();
    await parent.put(`/v1/child/links/${linkId}/zones/${zoneId}`, {
      name: 'School',
      kind: 'school',
      lat: 28.5707,
      lng: 77.3219,
      radiusM: 200,
    });
    const at = (lat: number, lng: number, accuracyM: number, mins: number) =>
      child.post('/v1/child/location', {
        lat,
        lng,
        accuracyM,
        recordedAt: new Date(Date.now() + mins * 60_000).toISOString(),
      });
    await at(28.6, 77.36, 10, 0); // outside: sets the state, no alert
    expect((await parent.get(`/v1/child/links/${linkId}/alerts`)).body.items).toHaveLength(0);
    await at(28.5707, 77.3219, 500, 1); // inside but far too rough: ignored
    expect((await parent.get(`/v1/child/links/${linkId}/alerts`)).body.items).toHaveLength(0);
    await at(28.5707, 77.3219, 10, 2); // inside: entry
    await at(28.5708, 77.322, 10, 3); // still inside: nothing new
    await at(28.6, 77.36, 10, 4); // outside: exit
    const alerts = (await parent.get(`/v1/child/links/${linkId}/alerts`)).body.items as any[];
    expect(alerts.map((a) => a.kind).sort()).toEqual(['zone_enter', 'zone_exit']);
    expect(alerts[0].title).toContain('Aarav');
    const link = (await parent.get('/v1/child/links')).body.items[0];
    expect(link.unseenAlerts).toBe(2);
    expect((await parent.post(`/v1/child/alerts/${alerts[0].id}/acknowledge`)).status).toBe(200);
    expect((await parent.get('/v1/child/links')).body.items[0].unseenAlerts).toBe(1);
  });

  it('raises exactly one route alert for a lasting deviation, and resets when back on route', async () => {
    const { parent, child, linkId } = await linkedPair();
    const routeId = randomUUID();
    const points = [
      [28.5707, 77.3219],
      [28.5807, 77.3219],
    ];
    await parent.put(`/v1/child/links/${linkId}/routes/${routeId}`, { name: 'To school', points });
    const at = (lat: number, lng: number, secs: number) =>
      child.post('/v1/child/location', {
        lat,
        lng,
        accuracyM: 10,
        recordedAt: new Date(Date.now() + secs * 1000).toISOString(),
      });
    const alerts = async () =>
      ((await parent.get(`/v1/child/links/${linkId}/alerts`)).body.items as any[]).filter(
        (a) => a.kind === 'route_deviation',
      );
    await at(28.575, 77.3219, 0); // on route
    await at(28.575, 77.33, 10); // about 800 m off: timer starts
    expect(await alerts()).toHaveLength(0);
    await at(28.575, 77.33, 60); // still within the allowed time
    expect(await alerts()).toHaveLength(0);
    await at(28.575, 77.3301, 200); // lasting: one alert
    await at(28.575, 77.3302, 260); // more of the same: still one
    expect(await alerts()).toHaveLength(1);
    await at(28.575, 77.3219, 300); // back on route
    await at(28.575, 77.33, 310);
    await at(28.575, 77.33, 500); // a new lasting deviation: a second alert
    expect(await alerts()).toHaveLength(2);
  });

  it('shows a stale warning for an old position', async () => {
    const { parent, child, linkId } = await linkedPair();
    await child.post('/v1/child/location', {
      lat: 28.57,
      lng: 77.32,
      accuracyM: 10,
      recordedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    const link = (await parent.get('/v1/child/links')).body.items[0];
    expect(link.lastLocation.stale).toBe(true);
    await child.post('/v1/child/location', { lat: 28.57, lng: 77.32, accuracyM: 10 });
    expect((await parent.get('/v1/child/links')).body.items[0].lastLocation.stale).toBe(false);
    void linkId;
  });
});

void ALL;
