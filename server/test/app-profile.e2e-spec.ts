import { randomUUID } from 'node:crypto';
import type { Me, UploadLink } from '@sarthi/shared';
import { PHOTO_UPLOADS_PER_HOUR } from '../src/app/profile/profile.controller';
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

beforeAll(async () => {
  ctx = await startAppTest();
  storage = ctx.app.get(StorageService);
});

beforeEach(async () => {
  await resetAppTest(ctx);
  ({ token, userId } = await appUser(ctx));
});

afterAll(async () => {
  // Leave no photos in the test bucket.
  const users = await ctx.db.selectFrom('users').select('photo_key').execute();
  await Promise.all(users.filter((u) => u.photo_key).map((u) => storage.delete(u.photo_key!)));
  await stopAppTest(ctx);
});

const api = () => http(ctx);
const jpeg = (size: number) => Buffer.alloc(size, 0xff);

async function uploadPhoto(body: Buffer, contentType = 'image/jpeg'): Promise<string> {
  const res = await api()
    .post('/v1/me/photo-upload')
    .set(bearer(token))
    .send({ sizeBytes: body.length })
    .expect(200);
  const link = res.body as UploadLink;
  const put = await fetch(link.uploadUrl, {
    method: 'PUT',
    headers: { ...link.headers, 'Content-Type': contentType },
    body,
  });
  if (contentType === 'image/jpeg') expect(put.status).toBe(200);
  return link.key;
}

describe('Profile', () => {
  it('starts empty', async () => {
    const res = await api().get('/v1/me').set(bearer(token)).expect(200);
    expect(res.body).toMatchObject({
      name: null,
      bloodGroup: null,
      gender: null,
      dateOfBirth: null,
      email: null,
      homeAddress: null,
      medicalNotes: null,
      photoUrl: null,
      consentGiven: true,
      guardiansCount: 0,
      acceptedGuardiansCount: 0,
    });
    expect((res.body as Me).rules).toMatchObject({
      'sos.countdown_seconds': 5,
      'guardian.max_count': 5,
    });
  });

  it('saves the name (trimmed) and blood group', async () => {
    const res = await api()
      .patch('/v1/me')
      .set(bearer(token))
      .send({ name: '  Priya Sharma ', bloodGroup: 'B+' })
      .expect(200);
    expect(res.body).toMatchObject({ name: 'Priya Sharma', bloodGroup: 'B+', photoUrl: null });
    const me = await api().get('/v1/me').set(bearer(token)).expect(200);
    expect(me.body).toMatchObject({ name: 'Priya Sharma', bloodGroup: 'B+' });
  });

  it('changes only what is sent; null clears the blood group', async () => {
    await api().patch('/v1/me').set(bearer(token)).send({ name: 'Priya', bloodGroup: 'O-' });
    const res = await api()
      .patch('/v1/me')
      .set(bearer(token))
      .send({ bloodGroup: null })
      .expect(200);
    expect(res.body).toMatchObject({ name: 'Priya', bloodGroup: null, photoUrl: null });
  });

  it.each(['प्रिया शर्मा', "D'Souza", 'Anil K. Singh-Rao', 'Ré'])(
    'accepts the name %p',
    async (name) => {
      const res = await api().patch('/v1/me').set(bearer(token)).send({ name }).expect(200);
      expect((res.body as Me).name).toBe(name);
    },
  );

  it('saves the other details (only for the user) and clears them with null or empty text', async () => {
    const res = await api()
      .patch('/v1/me')
      .set(bearer(token))
      .send({
        gender: 'female',
        dateOfBirth: '1998-03-21',
        email: ' Priya.S@Example.com ',
        homeAddress: '  C-56, Sector 62, Noida ',
        medicalNotes: 'Allergic to penicillin',
      })
      .expect(200);
    expect(res.body).toMatchObject({
      gender: 'female',
      dateOfBirth: '1998-03-21',
      email: 'priya.s@example.com',
      homeAddress: 'C-56, Sector 62, Noida',
      medicalNotes: 'Allergic to penicillin',
    });
    const me = await api().get('/v1/me').set(bearer(token)).expect(200);
    expect(me.body).toMatchObject({ dateOfBirth: '1998-03-21', gender: 'female' });

    const cleared = await api()
      .patch('/v1/me')
      .set(bearer(token))
      .send({ gender: null, dateOfBirth: null, email: '', homeAddress: '  ', medicalNotes: null })
      .expect(200);
    expect(cleared.body).toMatchObject({
      gender: null,
      dateOfBirth: null,
      email: null,
      homeAddress: null,
      medicalNotes: null,
    });
  });

  it.each([
    [{ gender: 'x' }, 'gender'],
    [{ dateOfBirth: '21-03-1998' }, 'dateOfBirth'],
    [{ dateOfBirth: '2999-01-01' }, 'real date of birth'],
    [{ email: 'not-an-email' }, 'email'],
    [{ homeAddress: 'x'.repeat(301) }, 'Address'],
    [{ medicalNotes: 'x'.repeat(501) }, 'Medical notes'],
  ])('refuses the detail %p', async (body, text) => {
    const res = await api().patch('/v1/me').set(bearer(token)).send(body).expect(400);
    expect((res.body as { message: string }).message).toContain(text);
  });

  it.each([
    [{ bloodGroup: 'C+' }, 'bloodGroup'],
    [{ name: '' }, 'name'],
    [{ name: 'A' }, 'name'],
    [{ name: 'x'.repeat(51) }, 'name'],
    [{ name: 'Priya 2' }, 'name'],
    [{ name: '-Priya' }, 'name'],
    [{}, 'at least one field'],
  ])('refuses %p', async (body, text) => {
    const res = await api().patch('/v1/me').set(bearer(token)).send(body).expect(400);
    expect(res.body).toEqual({
      error: 'invalid_input',
      message: expect.stringContaining(text) as unknown,
    });
  });

  it('needs login and consent', async () => {
    await api().get('/v1/me').expect(401);
  });
});

describe('Profile photo', () => {
  it('uploads with the link, then shows the photo through a link', async () => {
    const key = await uploadPhoto(jpeg(1000));
    expect(key.startsWith(`users/${userId}/photo/`)).toBe(true);

    const res = await api().post('/v1/me/photo').set(bearer(token)).send({ key }).expect(200);
    const photoUrl = (res.body as Me).photoUrl!;
    const download = await fetch(photoUrl);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).length).toBe(1000);
  });

  it('deletes the old photo when a new one is saved', async () => {
    const first = await uploadPhoto(jpeg(100));
    await api().post('/v1/me/photo').set(bearer(token)).send({ key: first }).expect(200);
    const second = await uploadPhoto(jpeg(200));
    await api().post('/v1/me/photo').set(bearer(token)).send({ key: second }).expect(200);

    expect(await storage.info(first)).toBeNull();
    expect(await storage.info(second)).not.toBeNull();
  });

  it('refuses a photo bigger than 2 MB before giving a link', async () => {
    const res = await api()
      .post('/v1/me/photo-upload')
      .set(bearer(token))
      .send({ sizeBytes: 2 * 1024 * 1024 + 1 })
      .expect(400);
    expect((res.body as { error: string }).error).toBe('invalid_input');
  });

  it("refuses another user's photo key", async () => {
    const otherKey = `users/${randomUUID()}/photo/${randomUUID()}.jpg`;
    await api().post('/v1/me/photo').set(bearer(token)).send({ key: otherKey }).expect(400);
  });

  it('refuses a key where nothing was uploaded', async () => {
    const res = await api()
      .post('/v1/me/photo-upload')
      .set(bearer(token))
      .send({ sizeBytes: 10 })
      .expect(200);
    const { key } = res.body as UploadLink;
    const save = await api().post('/v1/me/photo').set(bearer(token)).send({ key }).expect(400);
    expect((save.body as { message: string }).message).toContain('Nothing was uploaded');
  });

  it(`gives at most ${PHOTO_UPLOADS_PER_HOUR} upload links an hour`, async () => {
    for (let i = 0; i < PHOTO_UPLOADS_PER_HOUR; i++) {
      await api()
        .post('/v1/me/photo-upload')
        .set(bearer(token))
        .send({ sizeBytes: 10 })
        .expect(200);
    }
    await api().post('/v1/me/photo-upload').set(bearer(token)).send({ sizeBytes: 10 }).expect(429);
  });
});

describe('PUT /v1/device', () => {
  const device = () => ({
    deviceId: randomUUID(),
    model: 'Redmi Note 13',
    androidVersion: '14',
    appVersion: '1.0.0',
    pushToken: 'fcm-token-1',
    permissions: { location: true, notifications: true, sms: true, microphone: false },
    batteryOptimisationOff: true,
  });

  it('saves the phone and links it to the login session', async () => {
    const d = device();
    await api().put('/v1/me/device').set(bearer(token)).send(d).expect(204);

    const row = await ctx.db.selectFrom('devices').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      id: d.deviceId,
      user_id: userId,
      model: 'Redmi Note 13',
      android_version: '14',
      app_version: '1.0.0',
      push_token: 'fcm-token-1',
      permissions: d.permissions,
      battery_optimisation_off: true,
    });
    expect(row.last_seen_at).toBeInstanceOf(Date);
    const session = await ctx.db
      .selectFrom('user_sessions')
      .select('device_id')
      .executeTakeFirstOrThrow();
    expect(session.device_id).toBe(d.deviceId);
  });

  it('updates the same phone instead of adding a second one', async () => {
    const d = device();
    await api().put('/v1/me/device').set(bearer(token)).send(d).expect(204);
    await api()
      .put('/v1/me/device')
      .set(bearer(token))
      .send({ ...d, appVersion: '1.0.1', permissions: { ...d.permissions, microphone: true } })
      .expect(204);
    const rows = await ctx.db
      .selectFrom('devices')
      .select(['app_version', 'permissions'])
      .execute();
    expect(rows).toEqual([
      { app_version: '1.0.1', permissions: { ...d.permissions, microphone: true } },
    ]);
  });

  it('moves the phone to a different user who logs in on it', async () => {
    const d = device();
    await api().put('/v1/me/device').set(bearer(token)).send(d).expect(204);
    const other = await appUser(ctx, '+919812300000');
    await api().put('/v1/me/device').set(bearer(other.token)).send(d).expect(204);
    const rows = await ctx.db.selectFrom('devices').select('user_id').execute();
    expect(rows).toEqual([{ user_id: other.userId }]);
  });

  it('keeps a push token on one phone only', async () => {
    const first = device();
    await api().put('/v1/me/device').set(bearer(token)).send(first).expect(204);
    const second = { ...device(), pushToken: first.pushToken };
    await api().put('/v1/me/device').set(bearer(token)).send(second).expect(204);
    const old = await ctx.db
      .selectFrom('devices')
      .select('push_token')
      .where('id', '=', first.deviceId)
      .executeTakeFirstOrThrow();
    expect(old.push_token).toBeNull();
  });

  it('refuses missing permission keys', async () => {
    const d = device();
    const res = await api()
      .put('/v1/me/device')
      .set(bearer(token))
      .send({ ...d, permissions: { location: true } })
      .expect(400);
    expect((res.body as { message: string }).message).toContain('permissions');
  });

  it('makes the admin "Setup complete" check see the phone', async () => {
    await api().put('/v1/me/device').set(bearer(token)).send(device()).expect(204);
    const { rows } = await ctx.db
      .selectFrom('devices')
      .select((eb) => eb.ref('permissions', '->>').key('sms').as('sms'))
      .execute()
      .then((r) => ({ rows: r }));
    expect(rows).toEqual([{ sms: 'true' }]);
  });
});
