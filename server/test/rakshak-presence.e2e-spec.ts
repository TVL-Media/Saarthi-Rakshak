/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { sql } from 'kysely';
import { AdminPhase2Service } from '../src/app/phase2/admin-phase2';
import { CleanupService } from '../src/app/timers/cleanup.service';
import {
  appUser,
  bearer,
  http,
  resetAppTest,
  startAppTest,
  stopAppTest,
  type AppTestContext,
} from './app-test-support';

// "Available now" for approved Rakshaks: the phone sends its position, others see them nearby.
// Temporary records live only in the test database (wiped before each test).

let ctx: AppTestContext;
const api = () => http(ctx);
const HERE = { lat: 28.5707, lng: 77.3219 }; // Sector 18, Noida

beforeAll(async () => {
  ctx = await startAppTest();
});

beforeEach(async () => {
  await resetAppTest(ctx);
});

afterAll(async () => {
  await stopAppTest(ctx);
});

async function nearbyOn() {
  await ctx.db
    .insertInto('settings')
    .values({ key: 'feature.nearby', value: JSON.stringify(1) })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(1) }))
    .execute();
}

/** An approved Rakshak (approval itself is tested with the admin screens). */
async function approvedRakshak(phone = '+919812300001') {
  const r = await appUser(ctx, phone);
  await ctx.db
    .updateTable('users')
    .set({ name: 'Asha Verma' })
    .where('id', '=', r.userId)
    .execute();
  await ctx.db
    .insertInto('rakshak_applications')
    .values({
      user_id: r.userId,
      locked_details: 'locked',
      area: 'Sector 18',
      id_type: 'aadhaar',
      id_last4: '1234',
      consent_at: new Date(),
      status: 'approved',
    })
    .execute();
  return r;
}

const nearbyFor = async (token: string) =>
  (
    await api()
      .get(`/v1/rakshaks/nearby?lat=${HERE.lat}&lng=${HERE.lng}&radiusM=2000`)
      .set(bearer(token))
      .expect(200)
  ).body.items as { firstName: string; lat: number; distanceM: number }[];

describe('Rakshak "Available now"', () => {
  it('shows an available Rakshak to people nearby: first name and a rounded position only', async () => {
    await nearbyOn();
    const rakshak = await approvedRakshak();
    const user = await appUser(ctx, '+919812300002');
    expect(await nearbyFor(user.token)).toEqual([]);

    const on = await api()
      .post('/v1/rakshak/presence')
      .set(bearer(rakshak.token))
      .send({ lat: HERE.lat + 0.002, lng: HERE.lng, accuracyM: 15, start: true })
      .expect(200);
    const until = new Date(on.body.availableUntil as string).getTime();
    expect(until - Date.now()).toBeGreaterThan(3.9 * 3_600_000); // 4 hours by default
    expect(until - Date.now()).toBeLessThan(4.1 * 3_600_000);

    const items = await nearbyFor(user.token);
    expect(items).toHaveLength(1);
    expect(items[0].firstName).toBe('Asha');
    expect(JSON.stringify(items)).not.toContain('9812300001'); // never a phone number
    expect(items[0].lat).toBe(Math.round((HERE.lat + 0.002) * 1000) / 1000);
    // A Rakshak never sees themselves.
    expect(await nearbyFor(rakshak.token)).toEqual([]);

    // Only the latest position exists (one row, overwritten).
    await api()
      .post('/v1/rakshak/presence')
      .set(bearer(rakshak.token))
      .send({ lat: HERE.lat, lng: HERE.lng })
      .expect(200);
    expect(await ctx.db.selectFrom('rakshak_presence').selectAll().execute()).toHaveLength(1);

    // Off: gone at once, and the position is deleted.
    await api().delete('/v1/rakshak/presence').set(bearer(rakshak.token)).expect(204);
    expect(await nearbyFor(user.token)).toEqual([]);
    expect(await ctx.db.selectFrom('rakshak_presence').selectAll().execute()).toEqual([]);
  });

  it('refuses anyone not approved, and everyone while Rakshaks Near Me is switched off', async () => {
    const someone = await appUser(ctx, '+919812300003');
    await api()
      .post('/v1/rakshak/presence')
      .set(bearer(someone.token))
      .send({ ...HERE, start: true })
      .expect(404); // feature.nearby off
    await nearbyOn();
    const refused = await api()
      .post('/v1/rakshak/presence')
      .set(bearer(someone.token))
      .send({ ...HERE, start: true })
      .expect(409);
    expect(refused.body.message).toMatch(/approved Rakshaks/);
    await api()
      .post('/v1/rakshak/presence')
      .set(bearer(someone.token))
      .send({ lat: 200, lng: 0 })
      .expect(400);
  });

  it('switches itself off after the set hours, even if the phone never says "off"', async () => {
    await nearbyOn();
    const rakshak = await approvedRakshak();
    await api()
      .post('/v1/rakshak/presence')
      .set(bearer(rakshak.token))
      .send({ ...HERE, start: true })
      .expect(200);
    await ctx.db
      .updateTable('rakshak_presence')
      .set({ available_since: new Date(Date.now() - 5 * 3_600_000) })
      .execute();
    const late = await api()
      .post('/v1/rakshak/presence')
      .set(bearer(rakshak.token))
      .send(HERE)
      .expect(409);
    expect(late.body.message).toMatch(/has ended/);
    expect(await ctx.db.selectFrom('rakshak_presence').selectAll().execute()).toEqual([]);
    // Switching on again starts a new session.
    await api()
      .post('/v1/rakshak/presence')
      .set(bearer(rakshak.token))
      .send({ ...HERE, start: true })
      .expect(200);
  });

  it('the admin list says available now / last seen, never where; withdrawing and cleanup remove it', async () => {
    await nearbyOn();
    const rakshak = await approvedRakshak();
    await api()
      .post('/v1/rakshak/presence')
      .set(bearer(rakshak.token))
      .send({ ...HERE, start: true })
      .expect(200);
    const admin = ctx.app.get(AdminPhase2Service);
    const list = await admin.applications('approved');
    expect(list.items[0]).toMatchObject({ availableNow: true });
    expect(JSON.stringify(list)).not.toContain(String(HERE.lat));

    // An old position is deleted by the hourly cleanup (no location history).
    await ctx.db
      .updateTable('rakshak_presence')
      .set({ updated_at: sql<Date>`now() - interval '25 hours'` })
      .execute();
    await ctx.app.get(CleanupService).run();
    expect(await ctx.db.selectFrom('rakshak_presence').selectAll().execute()).toEqual([]);

    // Withdrawing the application removes the position too.
    await api()
      .post('/v1/rakshak/presence')
      .set(bearer(rakshak.token))
      .send({ ...HERE, start: true })
      .expect(200);
    await api().delete('/v1/rakshak/application').set(bearer(rakshak.token)).expect(204);
    expect(await ctx.db.selectFrom('rakshak_presence').selectAll().execute()).toEqual([]);
  });
});
