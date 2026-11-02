import type { SavedPlace } from '@sarthi/shared';
import { MAX_OTHER_PLACES } from '../src/app/places/places.service';
import { SUPPORT_TICKETS_PER_DAY } from '../src/app/support/support.service';
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
let token: string;
let userId: string;

beforeAll(async () => {
  ctx = await startAppTest();
});

beforeEach(async () => {
  await resetAppTest(ctx);
  ({ token, userId } = await appUser(ctx));
});

afterAll(() => stopAppTest(ctx));

const api = () => http(ctx);
const errorOf = (body: unknown) => (body as { error: string }).error;

const save = (body: Record<string, unknown>) =>
  api().post('/v1/places').set(bearer(token)).send(body);
const list = async () =>
  (await api().get('/v1/places').set(bearer(token)).expect(200)).body as SavedPlace[];

describe('Saved places', () => {
  it('saves Home, Work and others and lists Home and Work first', async () => {
    await save({ label: 'other', name: 'Gym', lat: 28.6, lng: 77.3 }).expect(200);
    const home = await save({
      label: 'home',
      name: 'Home',
      address: 'Sector 50, Noida',
      lat: 28.5706,
      lng: 77.3272,
    }).expect(200);
    expect(home.body).toMatchObject({
      label: 'home',
      name: 'Home',
      address: 'Sector 50, Noida',
      lat: 28.5706,
      lng: 77.3272,
    });
    await save({ label: 'work', name: 'Office', lat: 28.62, lng: 77.36 }).expect(200);

    expect((await list()).map((p) => p.name)).toEqual(['Home', 'Office', 'Gym']);
  });

  it('replaces Home when it is saved again', async () => {
    const first = (
      await save({ label: 'home', name: 'Old home', lat: 28.5, lng: 77.3 }).expect(200)
    ).body as SavedPlace;
    const second = (
      await save({ label: 'home', name: 'New home', lat: 28.7, lng: 77.4 }).expect(200)
    ).body as SavedPlace;
    expect(second.id).toBe(first.id);
    expect(await list()).toEqual([
      { id: first.id, label: 'home', name: 'New home', address: null, lat: 28.7, lng: 77.4 },
    ]);
  });

  it(`allows up to ${MAX_OTHER_PLACES} other places`, async () => {
    for (let i = 0; i < MAX_OTHER_PLACES; i++) {
      await save({ label: 'other', name: `Place ${i}`, lat: 28.5, lng: 77.3 }).expect(200);
    }
    const res = await save({ label: 'other', name: 'One more', lat: 28.5, lng: 77.3 }).expect(409);
    expect(errorOf(res.body)).toBe('limit_reached');
    await save({ label: 'home', name: 'Home', lat: 28.5, lng: 77.3 }).expect(200);
  });

  it('deletes only the user’s own place', async () => {
    const place = (await save({ label: 'home', name: 'Home', lat: 28.5, lng: 77.3 }).expect(200))
      .body as SavedPlace;
    const other = await appUser(ctx, '+919800000099');
    await api().delete(`/v1/places/${place.id}`).set(bearer(other.token)).expect(404);
    await api().delete(`/v1/places/${place.id}`).set(bearer(token)).expect(204);
    expect(await list()).toEqual([]);
    await api().delete(`/v1/places/${place.id}`).set(bearer(token)).expect(404);
  });

  it.each([
    [{ label: 'school', name: 'X', lat: 1, lng: 1 }, 'label'],
    [{ label: 'home', name: '', lat: 1, lng: 1 }, 'name'],
    [{ label: 'home', name: 'X', lat: 91, lng: 1 }, 'lat'],
    [{ label: 'home', name: 'X'.repeat(61), lat: 1, lng: 1 }, 'name'],
  ])('refuses %p', async (body, field) => {
    const res = await save(body).expect(400);
    expect((res.body as { message: string }).message).toContain(field);
  });

  it('needs login', async () => {
    await api().get('/v1/places').expect(401);
  });
});

describe('POST /v1/support-tickets', () => {
  const report = (body: Record<string, unknown>) =>
    api().post('/v1/support-tickets').set(bearer(token)).send(body);

  it('saves the ticket with the app version and phone model from the last device details', async () => {
    await ctx.db
      .insertInto('devices')
      .values({ user_id: userId, model: 'Redmi Note 12', app_version: '1.0.0 (1)' })
      .execute();
    await report({
      category: 'guardian_sms',
      message: '  My brother did not get the SMS.  ',
    }).expect(204);

    const ticket = await ctx.db.selectFrom('support_tickets').selectAll().executeTakeFirstOrThrow();
    expect(ticket).toMatchObject({
      user_id: userId,
      category: 'guardian_sms',
      message: 'My brother did not get the SMS.',
      status: 'open',
      app_version: '1.0.0 (1)',
      device_model: 'Redmi Note 12',
    });
  });

  it('uses the app version and model sent with the ticket', async () => {
    await report({
      category: 'other',
      message: 'Something else is wrong',
      appVersion: '1.0.1 (2)',
      deviceModel: 'Galaxy M14',
    }).expect(204);
    const ticket = await ctx.db.selectFrom('support_tickets').selectAll().executeTakeFirstOrThrow();
    expect(ticket).toMatchObject({ app_version: '1.0.1 (2)', device_model: 'Galaxy M14' });
  });

  it.each([
    [{ category: 'login', message: 'Long enough message' }, 'category'],
    [{ category: 'otp', message: 'short' }, 'message'],
    [{ category: 'otp', message: 'x'.repeat(2001) }, 'message'],
  ])('refuses %p', async (body, field) => {
    const res = await report(body).expect(400);
    expect((res.body as { message: string }).message).toContain(field);
  });

  it(`allows ${SUPPORT_TICKETS_PER_DAY} a day`, async () => {
    for (let i = 0; i < SUPPORT_TICKETS_PER_DAY; i++) {
      await report({ category: 'otp', message: `OTP did not come ${i}` }).expect(204);
    }
    const res = await report({ category: 'otp', message: 'OTP did not come again' }).expect(429);
    expect(errorOf(res.body)).toBe('too_many_requests');
  });
});
