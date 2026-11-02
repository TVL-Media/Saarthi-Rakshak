import { randomUUID } from 'node:crypto';
import type { Guardian, Sos } from '@sarthi/shared';
import { OutgoingMessages } from '../src/app/messages/outgoing-messages';
import { TEST_SOS_PER_DAY } from '../src/app/sos/sos.service';
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
let messages: OutgoingMessages;
let token: string;
let userId: string;

beforeAll(async () => {
  ctx = await startAppTest();
  messages = ctx.app.get(OutgoingMessages);
});

beforeEach(async () => {
  await resetAppTest(ctx);
  ({ token, userId } = await appUser(ctx));
  await api().patch('/v1/me').set(bearer(token)).send({ name: 'Priya Sharma' });
  messages.sent.length = 0;
});

afterAll(() => stopAppTest(ctx));

const api = () => http(ctx);
const errorOf = (body: unknown) => (body as { error: string }).error;
const now = () => new Date().toISOString();

async function addGuardian(name: string, phone: string, answer?: 'accept' | 'decline') {
  const res = await api()
    .post('/v1/guardians')
    .set(bearer(token))
    .send({ name, phone })
    .expect(201);
  const code = /\/i\/([A-Za-z0-9_-]+)/.exec(messages.sent.at(-1)!.text)![1];
  if (answer) await api().post(`/g/i/${code}/${answer}`).expect(204);
  return res.body as Guardian;
}

function startSos(extra: Record<string, unknown> = {}) {
  return api()
    .post('/v1/sos')
    .set(bearer(token))
    .send({ id: randomUUID(), trigger: 'button', startedAt: now(), ...extra });
}

describe('POST /v1/sos', () => {
  it('saves the SOS with a copy of the safety rules', async () => {
    const res = await startSos({ location: { lat: 28.5706, lng: 77.3272, accuracyM: 8 } }).expect(
      200,
    );
    const sos = res.body as Sos;
    expect(sos).toMatchObject({
      trigger: 'button',
      status: 'active',
      endedAt: null,
    });

    const row = await ctx.db.selectFrom('sos_events').selectAll().executeTakeFirstOrThrow();
    expect(row.user_id).toBe(userId);
    expect(row.rules).toMatchObject({ 'sos.no_response_minutes': 5, 'guardian.max_count': 5 });
    const points = await ctx.db
      .selectFrom('location_points')
      .select(['sos_event_id', 'accuracy_m'])
      .execute();
    expect(points).toEqual([{ sos_event_id: sos.id, accuracy_m: 8 }]);
  });

  it('copies a changed setting, and later changes do not affect it', async () => {
    await ctx.db
      .insertInto('settings')
      .values({ key: 'sos.no_response_minutes', value: JSON.stringify(7) })
      .execute();
    await startSos().expect(200);
    await ctx.db
      .updateTable('settings')
      .set({ value: JSON.stringify(9) })
      .execute();
    const row = await ctx.db.selectFrom('sos_events').select('rules').executeTakeFirstOrThrow();
    expect(row.rules!['sos.no_response_minutes']).toBe(7);
  });

  it('makes one secret link per guardian who accepted or has not answered, never declined', async () => {
    const accepted = await addGuardian('Ravi', '9800000001', 'accept');
    const pending = await addGuardian('Sita', '9800000002');
    await addGuardian('Amit', '9800000003', 'decline');
    messages.sent.length = 0;

    const res = await startSos().expect(200);
    const sos = res.body as Sos;
    expect(sos.guardians.map((g) => g.guardianId)).toEqual([accepted.id, pending.id]);

    const links = await ctx.db
      .selectFrom('guardian_links')
      .select(['token_hash', 'expires_at'])
      .execute();
    expect(links).toHaveLength(2);
    expect(links.every((l) => /^[0-9a-f]{64}$/.test(l.token_hash))).toBe(true);

    expect(messages.sent.map((m) => m.kind)).toEqual(['sos', 'sos']);
    expect(messages.sent[0].text).toContain('SOS from Priya Sharma');
    const codes = messages.sent.map((m) => /\/l\/([A-Za-z0-9_-]+)/.exec(m.text)![1]);
    expect(new Set(codes).size).toBe(2);
  });

  it('the same id twice gives one SOS and one set of alerts', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    messages.sent.length = 0;
    const body = { id: randomUUID(), trigger: 'widget', startedAt: now() };
    const first = await api().post('/v1/sos').set(bearer(token)).send(body).expect(200);
    const second = await api().post('/v1/sos').set(bearer(token)).send(body).expect(200);
    expect((second.body as Sos).id).toBe((first.body as Sos).id);
    expect(await ctx.db.selectFrom('sos_events').select('id').execute()).toHaveLength(1);
    expect(messages.sent).toHaveLength(1);
  });

  it('while one SOS is active, a new start returns the active one', async () => {
    const first = (await startSos().expect(200)).body as Sos;
    const second = (await startSos({ trigger: 'tile' }).expect(200)).body as Sos;
    expect(second.id).toBe(first.id);
    expect(await ctx.db.selectFrom('sos_events').select('id').execute()).toHaveLength(1);
  });

  it('two presses at the same moment still make only one SOS', async () => {
    await Promise.all([startSos(), startSos(), startSos()]);
    expect(await ctx.db.selectFrom('sos_events').select('id').execute()).toHaveLength(1);
  });

  it('guardians already reached by SIM SMS get only the live link', async () => {
    const ravi = await addGuardian('Ravi', '9800000001', 'accept');
    await addGuardian('Sita', '9800000002', 'accept');
    messages.sent.length = 0;
    await startSos({ simSmsSentTo: [ravi.id] }).expect(200);
    const byGuardian = new Map(messages.sent.map((m) => [m.guardianId, m]));
    expect(byGuardian.get(ravi.id)!.kind).toBe('sos_link');
    expect(byGuardian.get(ravi.id)!.text).toMatch(/^Priya Sharma's SOS live location/);
    expect([...byGuardian.values()].filter((m) => m.kind === 'sos')).toHaveLength(1);
  });

  it('GET /v1/sos/:id returns the SOS; another user gets not_found', async () => {
    const sos = (await startSos().expect(200)).body as Sos;
    const res = await api().get(`/v1/sos/${sos.id}`).set(bearer(token)).expect(200);
    expect((res.body as Sos).id).toBe(sos.id);
    const other = await appUser(ctx, '+919812399999');
    await api().get(`/v1/sos/${sos.id}`).set(bearer(other.token)).expect(404);
  });

  it('refuses a start time in the future or more than a day old', async () => {
    const future = new Date(Date.now() + 5 * 60_000).toISOString();
    expect(errorOf((await startSos({ startedAt: future }).expect(400)).body)).toBe('invalid_input');
    const old = new Date(Date.now() - 25 * 3600_000).toISOString();
    await startSos({ startedAt: old }).expect(400);
  });

  it("refuses another user's SOS id and an unknown journey", async () => {
    const id = randomUUID();
    await startSos({ id }).expect(200);
    const other = await appUser(ctx, '+919812399999');
    await api()
      .post('/v1/sos')
      .set(bearer(other.token))
      .send({ id, trigger: 'button', startedAt: now() })
      .expect(409);
    await api()
      .post('/v1/sos')
      .set(bearer(other.token))
      .send({
        id: randomUUID(),
        trigger: 'button',
        startedAt: now(),
        journeyId: randomUUID(),
      })
      .expect(400);
  });

  it('refuses an unknown trigger', async () => {
    await startSos({ trigger: 'shake' }).expect(400);
  });
});

describe('POST /v1/sos/test', () => {
  const test = () =>
    api().post('/v1/sos/test').set(bearer(token)).send({ id: randomUUID(), startedAt: now() });

  it('sends a TEST message to accepted guardians only, and nothing to end', async () => {
    const ravi = await addGuardian('Ravi', '9800000001', 'accept');
    await addGuardian('Sita', '9800000002'); // has not answered yet
    messages.sent.length = 0;

    const res = await test().expect(200);
    const sos = res.body as Sos;
    expect(sos).toMatchObject({ isTest: true, status: 'ended' });
    expect(sos.guardians.map((g) => g.guardianId)).toEqual([ravi.id]);
    expect(messages.sent).toHaveLength(1);
    expect(messages.sent[0]).toMatchObject({ guardianId: ravi.id, kind: 'test' });
    expect(messages.sent[0].text).toMatch(/^TEST from Priya Sharma/);
    expect(messages.sent[0].text).not.toMatch(/https?:/);
    // A test never blocks a real SOS.
    await startSos().expect(200);
  });

  it('refuses when no guardian has accepted yet', async () => {
    await addGuardian('Sita', '9800000002');
    expect(errorOf((await test().expect(409)).body)).toBe('conflict');
  });

  it(`allows ${TEST_SOS_PER_DAY} a day`, async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    for (let i = 0; i < TEST_SOS_PER_DAY; i++) await test().expect(200);
    await test().expect(429);
  });
});

describe('POST /v1/sos/:id/end ("I\'m safe")', () => {
  it('ends the SOS, keeps links open 15 more minutes and tells guardians', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    const sos = (await startSos().expect(200)).body as Sos;
    messages.sent.length = 0;

    const res = await api()
      .post(`/v1/sos/${sos.id}/end`)
      .set(bearer(token))
      .send({ reason: 'safe' })
      .expect(200);
    expect(res.body).toMatchObject({ status: 'ended', endedAt: expect.any(String) as unknown });

    const row = await ctx.db.selectFrom('sos_events').selectAll().executeTakeFirstOrThrow();
    expect(row.end_reason).toBe('safe');
    const minutesLeft = (row.guardian_link_expires_at!.getTime() - Date.now()) / 60_000;
    expect(minutesLeft).toBeGreaterThan(14);
    expect(minutesLeft).toBeLessThanOrEqual(15);
    const link = await ctx.db
      .selectFrom('guardian_links')
      .select('expires_at')
      .executeTakeFirstOrThrow();
    expect(new Date(link.expires_at).getTime()).toBe(row.guardian_link_expires_at!.getTime());

    expect(messages.sent.map((m) => m.kind)).toEqual(['safe']);
    expect(messages.sent[0].text).toContain('Priya Sharma is safe and has ended the SOS');
  });

  it('uses the link time copied when the SOS started', async () => {
    await ctx.db
      .insertInto('settings')
      .values({ key: 'guardian.link_live_after_end_minutes', value: JSON.stringify(30) })
      .execute();
    const sos = (await startSos().expect(200)).body as Sos;
    await ctx.db
      .updateTable('settings')
      .set({ value: JSON.stringify(5) })
      .execute();
    await api()
      .post(`/v1/sos/${sos.id}/end`)
      .set(bearer(token))
      .send({ reason: 'safe' })
      .expect(200);
    const row = await ctx.db
      .selectFrom('sos_events')
      .select('guardian_link_expires_at')
      .executeTakeFirstOrThrow();
    expect((row.guardian_link_expires_at!.getTime() - Date.now()) / 60_000).toBeGreaterThan(29);
  });

  it('ending twice is fine and tells guardians once', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    const sos = (await startSos().expect(200)).body as Sos;
    messages.sent.length = 0;
    await api()
      .post(`/v1/sos/${sos.id}/end`)
      .set(bearer(token))
      .send({ reason: 'safe' })
      .expect(200);
    await api()
      .post(`/v1/sos/${sos.id}/end`)
      .set(bearer(token))
      .send({ reason: 'safe' })
      .expect(200);
    expect(messages.sent).toHaveLength(1);
  });

  it("can't end another user's SOS", async () => {
    const sos = (await startSos().expect(200)).body as Sos;
    const other = await appUser(ctx, '+919812399999');
    await api()
      .post(`/v1/sos/${sos.id}/end`)
      .set(bearer(other.token))
      .send({ reason: 'safe' })
      .expect(404);
  });

  it('a new SOS can start after the last one ended', async () => {
    const first = (await startSos().expect(200)).body as Sos;
    await api()
      .post(`/v1/sos/${first.id}/end`)
      .set(bearer(token))
      .send({ reason: 'safe' })
      .expect(200);
    const second = (await startSos().expect(200)).body as Sos;
    expect(second.id).not.toBe(first.id);
  });
});

describe('POST /v1/sos/cancelled and GET /v1/sos/active', () => {
  it('saves a countdown cancel without alerts (admin History shows "Cancelled in the countdown")', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    messages.sent.length = 0;
    const id = randomUUID();
    const startedAt = new Date(Date.now() - 4000).toISOString();
    const body = { id, trigger: 'button', startedAt, cancelledAt: now() };
    await api().post('/v1/sos/cancelled').set(bearer(token)).send(body).expect(204);
    await api().post('/v1/sos/cancelled').set(bearer(token)).send(body).expect(204);

    const rows = await ctx.db.selectFrom('sos_events').select(['status', 'end_reason']).execute();
    expect(rows).toEqual([{ status: 'cancelled', end_reason: 'cancelled_in_countdown' }]);
    expect(messages.sent).toHaveLength(0);
    expect(await ctx.db.selectFrom('guardian_links').select('id').execute()).toHaveLength(0);
  });

  it('refuses a cancel time before the start time', async () => {
    await api()
      .post('/v1/sos/cancelled')
      .set(bearer(token))
      .send({
        id: randomUUID(),
        trigger: 'button',
        startedAt: now(),
        cancelledAt: new Date(Date.now() - 10_000).toISOString(),
      })
      .expect(400);
  });

  it('active: 204 when none, the SOS when one is running', async () => {
    await api().get('/v1/sos/active').set(bearer(token)).expect(204);
    const sos = (await startSos().expect(200)).body as Sos;
    const res = await api().get('/v1/sos/active').set(bearer(token)).expect(200);
    expect((res.body as Sos).id).toBe(sos.id);
  });
});
