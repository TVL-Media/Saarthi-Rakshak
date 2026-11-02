import { randomUUID } from 'node:crypto';
import type { Guardian, UploadLink } from '@sarthi/shared';
import { FakePhoneTokenVerifier, PhoneTokenVerifier } from '../src/app/auth/phone-token-verifier';
import { OutgoingMessages } from '../src/app/messages/outgoing-messages';
import { liveKeys } from '../src/app/locations/live-location';
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

const PHONE = '+919812344521';

let ctx: AppTestContext;
let messages: OutgoingMessages;
let verifier: FakePhoneTokenVerifier;
let storage: StorageService;
let token: string;
let userId: string;

beforeAll(async () => {
  ctx = await startAppTest();
  messages = ctx.app.get(OutgoingMessages);
  verifier = ctx.app.get<PhoneTokenVerifier, FakePhoneTokenVerifier>(PhoneTokenVerifier);
  storage = ctx.app.get(StorageService);
});

beforeEach(async () => {
  await resetAppTest(ctx);
  ({ token, userId } = await appUser(ctx, PHONE));
  await api().patch('/v1/me').set(bearer(token)).send({ name: 'Priya Sharma' });
  messages.sent.length = 0;
  verifier.deleted.length = 0;
});

afterAll(() => stopAppTest(ctx));

const api = () => http(ctx);
const errorOf = (body: unknown) => (body as { error: string }).error;

const deleteAccount = (body: Record<string, unknown> = {}) =>
  api()
    .delete('/v1/me')
    .set(bearer(token))
    .send({ firebaseIdToken: FakePhoneTokenVerifier.token(PHONE), confirm: 'DELETE', ...body });

async function addGuardian(name: string, phone: string) {
  const res = await api()
    .post('/v1/guardians')
    .set(bearer(token))
    .send({ name, phone })
    .expect(201);
  const code = /\/i\/([A-Za-z0-9_-]+)/.exec(messages.sent.at(-1)!.text)![1];
  await api().post(`/g/i/${code}/accept`).expect(204);
  return res.body as Guardian;
}

async function uploadPhoto(): Promise<string> {
  const body = Buffer.alloc(100, 1);
  const res = await api()
    .post('/v1/me/photo-upload')
    .set(bearer(token))
    .send({ sizeBytes: body.length })
    .expect(200);
  const link = res.body as UploadLink;
  const put = await fetch(link.uploadUrl, {
    method: 'PUT',
    headers: { ...link.headers, 'Content-Type': 'image/jpeg' },
    body,
  });
  expect(put.status).toBe(200);
  await api().post('/v1/me/photo').set(bearer(token)).send({ key: link.key }).expect(200);
  return link.key;
}

describe('DELETE /v1/me', () => {
  it('deletes the account: personal data, photo, sessions and the Firebase login; SOS kept anonymously', async () => {
    await addGuardian('Ravi', '9800000001');
    const photoKey = await uploadPhoto();
    const sosId = randomUUID();
    await api()
      .post('/v1/sos')
      .set(bearer(token))
      .send({ id: sosId, trigger: 'button', startedAt: new Date().toISOString() })
      .expect(200);
    await api()
      .post(`/v1/sos/${sosId}/end`)
      .set(bearer(token))
      .send({ reason: 'safe' })
      .expect(200);
    await api()
      .post('/v1/places')
      .set(bearer(token))
      .send({ label: 'home', name: 'Home', lat: 28.5, lng: 77.3 })
      .expect(200);
    await ctx.redis.zadd(liveKeys.heartbeats, Date.now(), userId);

    await deleteAccount().expect(204);

    expect(await ctx.db.selectFrom('users').selectAll().execute()).toEqual([]);
    expect(await ctx.db.selectFrom('guardians').selectAll().execute()).toEqual([]);
    expect(await ctx.db.selectFrom('saved_places').selectAll().execute()).toEqual([]);
    expect(await ctx.db.selectFrom('user_sessions').selectAll().execute()).toEqual([]);
    const sos = await ctx.db.selectFrom('sos_events').select(['id', 'user_id']).execute();
    expect(sos).toEqual([{ id: sosId, user_id: null }]);
    expect(await storage.info(photoKey)).toBeNull();
    expect(await ctx.redis.zscore(liveKeys.heartbeats, userId)).toBeNull();
    expect(verifier.deleted).toEqual([FakePhoneTokenVerifier.uid(PHONE)]);

    // The old token no longer works; logging in again makes a new, empty account.
    await api().get('/v1/me').set(bearer(token)).expect(401);
    const again = await appUser(ctx, PHONE);
    expect(again.userId).not.toBe(userId);
  });

  it('refuses an OTP older than 5 minutes', async () => {
    const old = new Date(Date.now() - 7 * 60_000);
    const res = await deleteAccount({
      firebaseIdToken: FakePhoneTokenVerifier.token(PHONE, old),
    }).expect(400);
    expect(errorOf(res.body)).toBe('invalid_input');
    expect(await ctx.db.selectFrom('users').select('id').execute()).toHaveLength(1);
  });

  it('refuses an OTP for another number', async () => {
    const res = await deleteAccount({
      firebaseIdToken: FakePhoneTokenVerifier.token('+919800000099'),
    }).expect(400);
    expect((res.body as { message: string }).message).toContain('different phone number');
    expect(verifier.deleted).toEqual([]);
  });

  it('refuses a bad Firebase token and a missing DELETE', async () => {
    await deleteAccount({ firebaseIdToken: 'nonsense' }).expect(401);
    const res = await deleteAccount({ confirm: 'delete' }).expect(400);
    expect((res.body as { message: string }).message).toContain('confirm');
  });

  it('refuses during an active SOS or journey', async () => {
    await addGuardian('Ravi', '9800000001');
    const sosId = randomUUID();
    await api()
      .post('/v1/sos')
      .set(bearer(token))
      .send({ id: sosId, trigger: 'button', startedAt: new Date().toISOString() })
      .expect(200);
    let res = await deleteAccount().expect(409);
    expect(res.body).toEqual({ error: 'conflict', message: 'End your SOS or journey first.' });
    await api()
      .post(`/v1/sos/${sosId}/end`)
      .set(bearer(token))
      .send({ reason: 'safe' })
      .expect(200);

    await api()
      .post('/v1/journeys')
      .set(bearer(token))
      .send({
        id: randomUUID(),
        destination: { lat: 28.57, lng: 77.32, label: 'Home' },
        expectedArrivalAt: new Date(Date.now() + 40 * 60_000).toISOString(),
      })
      .expect(200);
    res = await deleteAccount().expect(409);
    expect(errorOf(res.body)).toBe('conflict');
    expect(verifier.deleted).toEqual([]);
  });

  it('needs login', async () => {
    await api().delete('/v1/me').send({}).expect(401);
  });
});
