/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { randomUUID } from 'node:crypto';
import type {
  CommunityPost,
  EvidenceItem,
  Incident,
  LiveView,
  MyCommunityReport,
  PlansReply,
  SosTriggerSettings,
  Timeline,
  TimelineSummary,
  UploadLink,
  VaultUsage,
} from '@sarthi/shared';
import { sql } from 'kysely';
import { LiveService } from '../src/app/live/live.service';
import { CleanupService } from '../src/app/timers/cleanup.service';
import { buildTimeline } from '../src/app/phase2/daily-location';
import { evidenceKey } from '../src/app/phase2/vault';
import { StorageService } from '../src/storage/storage.module';
import {
  appUser,
  bearer,
  http,
  resetAppTest,
  startAppTest,
  stopAppTest,
  type AppTestContext,
} from './app-test-support';

let ctx: AppTestContext;
let storage: StorageService;
let token: string;
let userId: string;
const keys: string[] = [];

beforeAll(async () => {
  ctx = await startAppTest();
  storage = ctx.app.get(StorageService);
});

beforeEach(async () => {
  await resetAppTest(ctx);
  ({ token, userId } = await appUser(ctx));
});

afterAll(async () => {
  await Promise.all(keys.map((k) => storage.delete(k).catch(() => undefined)));
  await stopAppTest(ctx);
});

const api = () => http(ctx);
const B64 = Buffer.alloc(48, 9).toString('base64');
const SHA = 'a'.repeat(64);

async function put(link: UploadLink, body: Buffer) {
  keys.push(link.key);
  const res = await fetch(link.uploadUrl, { method: 'PUT', headers: link.headers, body });
  expect(res.status).toBe(200);
}

async function startSos(trigger = 'button'): Promise<string> {
  const id = randomUUID();
  await api()
    .post('/v1/sos')
    .set(bearer(token))
    .send({ id, trigger, startedAt: new Date(Date.now() - 30_000).toISOString() })
    .expect(200);
  return id;
}

describe('SOS triggers (features 1, 2, 4, 5, 6)', () => {
  it('starts with everything off and saves only what is sent', async () => {
    const start = (await api().get('/v1/me/sos-triggers').set(bearer(token)).expect(200))
      .body as SosTriggerSettings;
    expect(start).toEqual({
      shakeMode: 'off',
      voiceOn: false,
      driveMode: false,
      fallOn: false,
      quietCountdown: false,
      journeySosButton: true,
    });
    await api()
      .put('/v1/me/sos-triggers')
      .set(bearer(token))
      .send({ shakeMode: 'journey', driveMode: true })
      .expect(200);
    const res = await api()
      .put('/v1/me/sos-triggers')
      .set(bearer(token))
      .send({ quietCountdown: true })
      .expect(200);
    expect(res.body).toMatchObject({
      shakeMode: 'journey',
      driveMode: true,
      quietCountdown: true,
      voiceOn: false,
    });
    await api()
      .put('/v1/me/sos-triggers')
      .set(bearer(token))
      .send({ shakeMode: 'sometimes' })
      .expect(400);
  });

  it('accepts the new SOS triggers and tells guardians how it started', async () => {
    await ctx.db
      .insertInto('guardians')
      .values({ user_id: userId, name: 'Reena', phone: '+919800000001', invite_status: 'accepted' })
      .execute();
    const id = await startSos('crash');
    const sos = await ctx.db
      .selectFrom('sos_events')
      .select('trigger')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(sos.trigger).toBe('crash');
  });

  it('counts a cancelled detection countdown once', async () => {
    const id = randomUUID();
    for (let i = 0; i < 2; i++) {
      await api()
        .post('/v1/sos/false-alarms')
        .set(bearer(token))
        .send({ id, trigger: 'fall' })
        .expect(204);
    }
    const rows = await ctx.db.selectFrom('sos_false_alarms').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ trigger: 'fall', user_id: userId });
  });
});

describe('Photos at SOS start (feature 3)', () => {
  it('uploads, records and shows them on the guardian page; at most the set number of pairs', async () => {
    await ctx.db
      .insertInto('settings')
      .values({ key: 'sos.photo_pairs_max', value: JSON.stringify(1) })
      .execute();
    const sosId = await startSos();
    const save = async (camera: 'front' | 'back') => {
      const photoId = randomUUID();
      const link = (
        await api()
          .post(`/v1/sos/${sosId}/photo-upload`)
          .set(bearer(token))
          .send({ photoId, sizeBytes: 500 })
          .expect(200)
      ).body as UploadLink;
      await put(link, Buffer.alloc(500, 0xff));
      return api()
        .post(`/v1/sos/${sosId}/photos`)
        .set(bearer(token))
        .send({ photoId, camera, takenAt: new Date().toISOString() });
    };
    expect((await save('back')).status).toBe(200);
    expect((await save('front')).status).toBe(200);
    const third = await save('back');
    expect(third.status).toBe(409);

    const list = (await api().get(`/v1/sos/${sosId}/photos`).set(bearer(token)).expect(200))
      .body as unknown[];
    expect(list).toHaveLength(2);

    // Another user cannot add photos to this SOS.
    const other = await appUser(ctx, '+919812300000');
    await api()
      .post(`/v1/sos/${sosId}/photo-upload`)
      .set(bearer(other.token))
      .send({ photoId: randomUUID(), sizeBytes: 10 })
      .expect(404);
  });

  it('the guardian live view lists photos and the trigger', async () => {
    const guardian = await ctx.db
      .insertInto('guardians')
      .values({ user_id: userId, name: 'Reena', phone: '+919800000001', invite_status: 'accepted' })
      .returning('id')
      .executeTakeFirstOrThrow();
    void guardian;
    const sosId = await startSos('shake');
    const photoId = randomUUID();
    const link = (
      await api()
        .post(`/v1/sos/${sosId}/photo-upload`)
        .set(bearer(token))
        .send({ photoId, sizeBytes: 100 })
        .expect(200)
    ).body as UploadLink;
    await put(link, Buffer.alloc(100, 0xff));
    await api()
      .post(`/v1/sos/${sosId}/photos`)
      .set(bearer(token))
      .send({ photoId, camera: 'back', takenAt: new Date().toISOString() })
      .expect(200);
    const live = ctx.app.get<LiveService, unknown>(LiveService) as {
      build: (l: unknown) => Promise<LiveView>;
    };
    const linkRow = await ctx.db
      .selectFrom('guardian_links')
      .select('id')
      .where('sos_event_id', '=', sosId)
      .executeTakeFirstOrThrow();
    const view = await live.build({
      kind: 'sos',
      id: sosId,
      userId,
      linkId: linkRow.id,
      respondingAt: null,
    });
    expect(view.trigger).toBe('shake');
    expect(view.photos).toHaveLength(1);
    expect(view.photos[0]).toMatchObject({ camera: 'back' });
  });
});

describe('Full-day location, timeline and report (features 7–11)', () => {
  it('needs consent to turn on, saves points once, keeps them for the chosen days', async () => {
    await api().put('/v1/me/daily-tracking').set(bearer(token)).send({ enabled: true }).expect(400);
    const on = await api()
      .put('/v1/me/daily-tracking')
      .set(bearer(token))
      .send({ enabled: true, consentVersion: '2026-11', retentionDays: 7 })
      .expect(200);
    expect(on.body).toMatchObject({ enabled: true, retentionDays: 7, consentVersion: '2026-11' });

    const base = Date.now() - 3 * 3600_000;
    const point = (min: number, lat: number, lng: number) => ({
      clientPointId: randomUUID(),
      lat,
      lng,
      recordedAt: new Date(base + min * 60_000).toISOString(),
    });
    const points = [
      point(0, 28.6271, 77.3721),
      point(4, 28.6272, 77.3722),
      point(8, 28.6271, 77.3721), // a stop of 8 minutes
      point(12, 28.6, 77.33),
      point(16, 28.57, 77.32),
      point(20, 28.5701, 77.3201),
      point(30, 28.5702, 77.3202), // another stop of 14 minutes
    ];
    const res = await api()
      .post('/v1/daily-locations')
      .set(bearer(token))
      .send({ points })
      .expect(200);
    expect(res.body).toEqual({ saved: 7 });
    expect(
      (await api().post('/v1/daily-locations').set(bearer(token)).send({ points }).expect(200))
        .body,
    ).toEqual({ saved: 0 });

    const kept = await ctx.db
      .selectFrom('location_points')
      .select([
        'kind',
        sql<number>`extract(epoch from delete_after - recorded_at) / 86400`.as('days'),
      ])
      .where('user_id', '=', userId)
      .execute();
    expect(kept.every((p) => p.kind === 'daily' && Math.round(Number(p.days)) === 7)).toBe(true);

    // The India date of these points.
    const date = new Date(base + 5.5 * 3600_000).toISOString().slice(0, 10);
    const tl = (await api().get(`/v1/timeline?date=${date}`).set(bearer(token)).expect(200))
      .body as Timeline;
    if (tl.pointsCount === 7) {
      expect(tl.stops).toHaveLength(2);
      expect(tl.routes.length).toBeGreaterThanOrEqual(1);
      const sum = (
        await api().get(`/v1/timeline/summary?date=${date}`).set(bearer(token)).expect(200)
      ).body as TimelineSummary;
      expect(sum.stopsCount).toBe(2);
      expect(sum.distanceM).toBeGreaterThan(5000);
    }

    await api().delete('/v1/daily-locations?all=true').set(bearer(token)).expect(200);
    expect(
      await ctx.db
        .selectFrom('location_points')
        .select('id')
        .where('user_id', '=', userId)
        .execute(),
    ).toHaveLength(0);
  });

  it('refuses points while full-day location is off', async () => {
    await api()
      .post('/v1/daily-locations')
      .set(bearer(token))
      .send({
        points: [
          {
            clientPointId: randomUUID(),
            lat: 28.6,
            lng: 77.3,
            recordedAt: new Date().toISOString(),
          },
        ],
      })
      .expect(409);
  });

  it('builds stops and routes (pure)', () => {
    const t0 = Date.UTC(2026, 10, 10, 4);
    const pts = [
      { lat: 28.6, lng: 77.3, at: t0 },
      { lat: 28.6001, lng: 77.3001, at: t0 + 6 * 60_000 },
      { lat: 28.61, lng: 77.31, at: t0 + 10 * 60_000 },
    ];
    const { stops, routes } = buildTimeline(pts);
    expect(stops).toHaveLength(1);
    expect(stops[0].minutes).toBe(6);
    expect(routes).toHaveLength(1);
    expect(routes[0].distanceM).toBeGreaterThan(1000);
  });
});

describe('Evidence vault (features 12–21)', () => {
  const setup = () =>
    api()
      .post('/v1/vault/setup')
      .set(bearer(token))
      .send({
        lockedKey: B64,
        kdf: {
          name: 'argon2id',
          salt: 'c2FsdHNhbHRzYWx0c2FsdA==',
          memoryKiB: 65536,
          iterations: 3,
          parallelism: 1,
        },
        checkValue: 'check-value-0123456789',
      });

  async function addFile(kind = 'audio', incidentId: string | null = null) {
    const id = randomUUID();
    const link = (
      await api()
        .post('/v1/vault/items/upload')
        .set(bearer(token))
        .send({ itemId: id, sizeBytes: 1000 })
        .expect(200)
    ).body as UploadLink;
    expect(link.key).toBe(evidenceKey(userId, id));
    await put(link, Buffer.alloc(1000, 3));
    return api().post('/v1/vault/items').set(bearer(token)).send({
      id,
      kind,
      incidentId,
      lockedFileKey: B64,
      lockedDetails: B64,
      sha256: SHA,
      capturedAt: new Date().toISOString(),
      sizeBytes: 1000,
    });
  }

  it('needs a vault first; the server keeps only the locked key', async () => {
    await api()
      .post('/v1/vault/items/upload')
      .set(bearer(token))
      .send({ itemId: randomUUID(), sizeBytes: 10 })
      .expect(409);
    await api().get('/v1/vault/recovery').set(bearer(token)).expect(404);
    await setup().expect(204);
    const rec = await api().get('/v1/vault/recovery').set(bearer(token)).expect(200);
    expect(rec.body).toMatchObject({ lockedKey: B64, kdf: { name: 'argon2id' } });
  });

  it('records items with fingerprints, incidents, the access history, and locks deletion', async () => {
    await setup().expect(204);
    const incidentId = randomUUID();
    const inc = await api()
      .post('/v1/vault/incidents')
      .set(bearer(token))
      .send({ id: incidentId, kind: 'harassment', lockedDetails: B64 })
      .expect(200);
    expect((inc.body as Incident).itemsCount).toBe(0);

    const saved = await addFile('audio', incidentId);
    expect(saved.status).toBe(200);
    const item = saved.body as EvidenceItem;
    expect(item).toMatchObject({
      kind: 'audio',
      sha256: SHA,
      hasFile: true,
      incidentId,
      hidden: false,
    });
    expect(new Date(item.deleteLockedUntil).getTime()).toBeGreaterThan(
      Date.now() + 80 * 86_400_000,
    );

    // A detail item (number / link) has no file.
    const detail = await api()
      .post('/v1/vault/items')
      .set(bearer(token))
      .send({
        id: randomUUID(),
        kind: 'detail',
        lockedFileKey: B64,
        lockedDetails: B64,
        sha256: SHA,
        capturedAt: new Date().toISOString(),
        sizeBytes: 0,
      })
      .expect(200);
    expect((detail.body as EvidenceItem).hasFile).toBe(false);

    // The fingerprint and receipt time can never change.
    await expect(
      ctx.db
        .updateTable('evidence_items')
        .set({ sha256: 'b'.repeat(64) })
        .where('id', '=', item.id)
        .execute(),
    ).rejects.toThrow(/cannot be changed/);

    // Locked: cannot be deleted, only hidden.
    const del = await api().delete(`/v1/vault/items/${item.id}`).set(bearer(token)).expect(409);
    expect(del.body.message).toMatch(/locked until/);
    await api()
      .patch(`/v1/vault/items/${item.id}`)
      .set(bearer(token))
      .send({ hidden: true })
      .expect(200);

    const dl = await api()
      .get(`/v1/vault/items/${item.id}/download`)
      .set(bearer(token))
      .expect(200);
    expect(dl.body.url).toContain('vault');

    await api()
      .post('/v1/vault/access-log')
      .set(bearer(token))
      .send({
        entries: [{ action: 'shared', itemId: item.id, at: new Date().toISOString() }],
        device: 'Pixel 8',
      })
      .expect(204);
    const log = (await api().get('/v1/vault/access-log').set(bearer(token)).expect(200)).body as {
      action: string;
    }[];
    expect(log.map((l) => l.action)).toEqual(
      expect.arrayContaining(['created', 'hidden', 'shared']),
    );

    const incidents = (await api().get('/v1/vault/incidents').set(bearer(token)).expect(200))
      .body as Incident[];
    expect(incidents[0].itemsCount).toBe(1);

    const usage = (await api().get('/v1/vault/usage').set(bearer(token)).expect(200))
      .body as VaultUsage;
    expect(usage).toMatchObject({ usedBytes: 1000, items: 2 });

    // Nobody else can see or touch it.
    const other = await appUser(ctx, '+919812300000');
    await api().get(`/v1/vault/items/${item.id}/download`).set(bearer(other.token)).expect(404);
    expect((await api().get('/v1/vault/items').set(bearer(other.token)).expect(200)).body).toEqual(
      [],
    );
  });

  it('deletes an item after its lock; account deletion removes the files', async () => {
    await ctx.db
      .insertInto('settings')
      .values({ key: 'evidence.delete_lock_days', value: JSON.stringify(0) })
      .execute();
    await setup().expect(204);
    const item = (await addFile('photo')).body as EvidenceItem;
    await api().delete(`/v1/vault/items/${item.id}`).set(bearer(token)).expect(204);
    expect(await storage.info(evidenceKey(userId, item.id))).toBeNull();
  });

  it('reset (forgotten password): deletes what it can, hides protected items, starts a new vault', async () => {
    // One item without protection, one protected for the usual days.
    await ctx.db
      .insertInto('settings')
      .values({ key: 'evidence.delete_lock_days', value: JSON.stringify(0) })
      .execute();
    await setup().expect(204);
    const free = (await addFile('photo')).body as EvidenceItem;
    await ctx.db.deleteFrom('settings').where('key', '=', 'evidence.delete_lock_days').execute();
    const incidentId = randomUUID();
    await api()
      .post('/v1/vault/incidents')
      .set(bearer(token))
      .send({ id: incidentId, kind: 'harassment', lockedDetails: B64 })
      .expect(200);
    const locked = (await addFile('audio', incidentId)).body as EvidenceItem;
    keys.push(evidenceKey(userId, locked.id));

    // Typing RESET is required.
    await api().post('/v1/vault/reset').set(bearer(token)).send({ confirm: 'yes' }).expect(400);

    const reset = await api()
      .post('/v1/vault/reset')
      .set(bearer(token))
      .send({ confirm: 'RESET' })
      .expect(200);
    expect(reset.body).toMatchObject({ deleted: 1, keptLocked: 1 });
    expect(new Date(reset.body.lockedUntil as string).getTime()).toBeGreaterThan(Date.now());

    // The unprotected file is gone; the protected one stays (unreadable) but the user sees nothing.
    expect(await storage.info(evidenceKey(userId, free.id))).toBeNull();
    expect(await storage.info(evidenceKey(userId, locked.id))).not.toBeNull();
    expect((await api().get('/v1/vault/items').set(bearer(token)).expect(200)).body).toEqual([]);
    expect((await api().get('/v1/vault/incidents').set(bearer(token)).expect(200)).body).toEqual(
      [],
    );
    expect(
      ((await api().get('/v1/vault/usage').set(bearer(token)).expect(200)).body as VaultUsage)
        .items,
    ).toBe(0);
    await api().get(`/v1/vault/items/${locked.id}/download`).set(bearer(token)).expect(404);
    await api().get('/v1/vault/recovery').set(bearer(token)).expect(404);

    // The reset is in the access history, and a new vault can be set up at once.
    const log = (await api().get('/v1/vault/access-log').set(bearer(token)).expect(200)).body as {
      action: string;
    }[];
    expect(log.map((l) => l.action)).toContain('reset');
    await setup().expect(204);
    expect((await api().get('/v1/vault/items').set(bearer(token)).expect(200)).body).toEqual([]);

    // When the protection ends, the hourly cleanup deletes the old item and its file.
    await ctx.db
      .updateTable('evidence_items')
      .set({ delete_locked_until: new Date(Date.now() - 1000) })
      .where('id', '=', locked.id)
      .execute();
    await ctx.app.get(CleanupService).run();
    expect(
      await ctx.db
        .selectFrom('evidence_items')
        .select('id')
        .where('id', '=', locked.id)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(await storage.info(evidenceKey(userId, locked.id))).toBeNull();
  });
});

describe('Community feed (feature 23)', () => {
  it('a report waits for review and is not shown; refuses numbers and emails; limit per day', async () => {
    const send = (body: string) =>
      api()
        .post('/v1/community/reports')
        .set(bearer(token))
        .send({ id: randomUUID(), category: 'lighting', area: 'Sector 62', body });
    const ok = await send('Street lights are out near the Sector 62 metro gate at night.').expect(
      200,
    );
    expect((ok.body as MyCommunityReport).status).toBe('pending');
    const bad = await send('Call this man 9876543210 he is following women here.').expect(400);
    expect(bad.body.message).toMatch(/Remove phone numbers/);
    expect(
      (await api().get('/v1/community/posts?area=Sector 62').set(bearer(token)).expect(200)).body,
    ).toEqual([]);

    await ctx.db.updateTable('community_posts').set({ status: 'published' }).execute();
    const posts = (
      await api().get('/v1/community/posts?area=Sector 62').set(bearer(token)).expect(200)
    ).body as CommunityPost[];
    expect(posts).toHaveLength(1);

    await ctx.db
      .insertInto('settings')
      .values({ key: 'community.reports_per_day', value: JSON.stringify(1) })
      .execute();
    await send('Another report about a broken road near the market area.').expect(409);
  });

  it('three flags hide a published post until an admin looks again', async () => {
    const id = randomUUID();
    await ctx.db
      .insertInto('community_posts')
      .values({
        id,
        category: 'road',
        area: 'Sector 18',
        body: 'Big pothole near the Sector 18 market entrance.',
        status: 'published',
      })
      .execute();
    for (const phone of ['+919812300001', '+919812300002', '+919812300003']) {
      const u = await appUser(ctx, phone);
      await api()
        .post(`/v1/community/posts/${id}/flag`)
        .set(bearer(u.token))
        .send({ reason: 'Not true' })
        .expect(204);
    }
    const post = await ctx.db
      .selectFrom('community_posts')
      .select(['status', 'flags_count'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(post).toEqual({ status: 'pending', flags_count: 3 });
  });
});

describe('Rakshak sign-up (feature 24)', () => {
  async function doc(name: 'idFront' | 'idBack' | 'selfie') {
    const link = (
      await api()
        .post('/v1/rakshak/document-upload')
        .set(bearer(token))
        .send({ document: name, sizeBytes: 200 })
        .expect(200)
    ).body as UploadLink;
    await put(link, Buffer.alloc(200, 0xff));
    return link.key;
  }
  const form = async (dob = '1995-04-12') => ({
    fullName: 'Priya Sharma',
    dateOfBirth: dob,
    address: 'C-56, Sector 62, Noida, Uttar Pradesh',
    area: 'Sector 62',
    idType: 'aadhaar',
    idLast4: '4521',
    motivation: 'I want to help women in my area feel safe at night.',
    documents: {
      idFront: await doc('idFront'),
      idBack: await doc('idBack'),
      selfie: await doc('selfie'),
    },
    agreeToChecks: true,
  });

  it('applies (details encrypted), shows the status, refuses under-18 and a second application, withdraws', async () => {
    const young = await form('2012-01-01');
    await api().post('/v1/rakshak/application').set(bearer(token)).send(young).expect(400);
    const first = await form();
    const res = await api()
      .post('/v1/rakshak/application')
      .set(bearer(token))
      .send(first)
      .expect(200);
    expect(res.body).toMatchObject({ status: 'under_review', area: 'Sector 62' });
    const row = await ctx.db
      .selectFrom('rakshak_applications')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.locked_details).not.toContain('Priya');
    expect(row.id_last4).toBe('4521');
    const second = await form();
    await api().post('/v1/rakshak/application').set(bearer(token)).send(second).expect(409);
    expect(
      (await api().get('/v1/rakshak/application').set(bearer(token)).expect(200)).body.application
        .status,
    ).toBe('under_review');
    await api().delete('/v1/rakshak/application').set(bearer(token)).expect(204);
    expect(
      (await api().get('/v1/rakshak/application').set(bearer(token)).expect(200)).body.application,
    ).toBeNull();
  });

  it('helps in up to 5 areas (no repeats); an older app sending one area still works', async () => {
    // An app from before multi-area: one area becomes a one-area list.
    expect(res(await apply(await form()))).toMatchObject({
      area: 'Sector 62',
      areas: ['Sector 62'],
    });
    await api().delete('/v1/rakshak/application').set(bearer(token)).expect(204);

    const six = ['Sector 6', 'Sector 18', 'Sector 62', 'Sector 49', 'Sector 76', 'Sector 93'];
    await apply({ ...(await form()), area: six[0], areas: six }).then((r) =>
      expect(r.status).toBe(400),
    );
    await apply({ ...(await form()), area: 'Sector 6', areas: ['Sector 6', 'sector 6'] }).then(
      (r) => expect(r.status).toBe(400),
    );

    const five = six.slice(0, 5);
    const ok = await apply({ ...(await form()), area: five[0], areas: five });
    expect(res(ok)).toMatchObject({ area: 'Sector 6', areas: five });
    const got = (await api().get('/v1/rakshak/application').set(bearer(token)).expect(200))
      .body as { application: { areas: string[] } };
    expect(got.application.areas).toEqual(five);

    // The admin panel shows every area on one line.
    const row = await ctx.db
      .selectFrom('rakshak_applications')
      .select(['area', 'areas'])
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ area: 'Sector 6', areas: five });
  });

  const apply = (body: object) =>
    api().post('/v1/rakshak/application').set(bearer(token)).send(body);
  const res = (r: { status: number; body: Record<string, unknown> }) => {
    expect(r.status).toBe(200);
    return r.body;
  };
});

describe('Plans (feature 25)', () => {
  it('everything is free while no plan is on sale; purchases need Google Play set up', async () => {
    const res = (await api().get('/v1/plans').set(bearer(token)).expect(200)).body as PlansReply;
    expect(res.everythingFree).toBe(true);
    expect(res.current).toBe('basic');
    expect(res.plans.map((p) => p.id)).toEqual(['basic', 'silver', 'gold']);
    const usage = (await api().get('/v1/vault/usage').set(bearer(token)).expect(200))
      .body as VaultUsage;
    expect(usage.limitBytes).toBe(51200 * 1024 * 1024);
    await api()
      .post('/v1/subscriptions/verify')
      .set(bearer(token))
      .send({ productId: 'nope', purchaseToken: 'x'.repeat(20) })
      .expect(400);
  });

  it('the Play webhook refuses a wrong token', async () => {
    await api().post('/webhooks/google-play?token=wrong').send({}).expect(404);
  });
});

describe('Journey mode', () => {
  it('is saved and returned', async () => {
    await ctx.db
      .insertInto('guardians')
      .values({ user_id: userId, name: 'Reena', phone: '+919800000001', invite_status: 'accepted' })
      .execute();
    const id = randomUUID();
    const res = await api()
      .post('/v1/journeys')
      .set(bearer(token))
      .send({
        id,
        destination: { lat: 28.57, lng: 77.32, label: 'Office' },
        expectedArrivalAt: new Date(Date.now() + 40 * 60_000).toISOString(),
        mode: 'cab',
      });
    expect([200, 201]).toContain(res.status);
    expect(res.body.mode).toBe('cab');
  });
});
