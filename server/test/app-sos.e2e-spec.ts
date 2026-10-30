import { randomUUID } from 'node:crypto';
import type { Guardian, Sos } from '@sarthi/shared';
import { OutgoingMessages } from '../src/app/messages/outgoing-messages';
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
  await api().patch('/app/profile').set(bearer(token)).send({ name: 'Priya Sharma' });
  messages.sent.length = 0;
});

afterAll(() => stopAppTest(ctx));

const api = () => http(ctx);
const errorOf = (body: unknown) => (body as { error: string }).error;
const now = () => new Date().toISOString();

async function addGuardian(name: string, phone: string, answer?: 'accept' | 'decline') {
  const res = await api()
    .post('/app/guardians')
    .set(bearer(token))
    .send({ name, phone })
    .expect(201);
  const code = /\/invite\/([A-Za-z0-9_-]+)/.exec(messages.sent.at(-1)!.text)![1];
  if (answer) await api().post(`/g/invite/${code}/${answer}`).expect(204);
  return res.body as Guardian;
}

function startSos(extra: Record<string, unknown> = {}) {
  return api()
    .post('/app/sos')
    .set(bearer(token))
    .send({ id: randomUUID(), trigger: 'button', isTest: false, startedAt: now(), ...extra });
}

describe('POST /app/sos', () => {
  it('saves the SOS with a copy of the safety rules', async () => {
    const res = await startSos({ location: { lat: 28.5706, lng: 77.3272, accuracyM: 8 } }).expect(
      200,
    );
    const sos = res.body as Sos;
    expect(sos).toMatchObject({
      trigger: 'button',
      isTest: false,
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
    const codes = messages.sent.map((m) => /\/g\/([A-Za-z0-9_-]+)/.exec(m.text)![1]);
    expect(new Set(codes).size).toBe(2);
  });

  it('the same id twice gives one SOS and one set of alerts', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    messages.sent.length = 0;
    const body = { id: randomUUID(), trigger: 'widget', isTest: false, startedAt: now() };
    const first = await api().post('/app/sos').set(bearer(token)).send(body).expect(200);
    const second = await api().post('/app/sos').set(bearer(token)).send(body).expect(200);
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

  it('a test SOS says TEST in the message', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    messages.sent.length = 0;
    const res = await startSos({ isTest: true }).expect(200);
    expect((res.body as Sos).isTest).toBe(true);
    expect(messages.sent[0].text).toMatch(/^TEST SOS from Priya Sharma/);
  });

  it('works for a blocked user', async () => {
    await ctx.db.updateTable('users').set({ status: 'blocked' }).execute();
    await startSos().expect(200);
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
      .post('/app/sos')
      .set(bearer(other.token))
      .send({ id, trigger: 'button', isTest: false, startedAt: now() })
      .expect(409);
    await api()
      .post('/app/sos')
      .set(bearer(other.token))
      .send({
        id: randomUUID(),
        trigger: 'button',
        isTest: false,
        startedAt: now(),
        journeyId: randomUUID(),
      })
      .expect(400);
  });

  it('refuses an unknown trigger', async () => {
    await startSos({ trigger: 'shake' }).expect(400);
  });
});

describe('POST /app/sos/:id/end ("I\'m safe")', () => {
  it('ends the SOS, keeps links open 15 more minutes and tells guardians', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    const sos = (await startSos().expect(200)).body as Sos;
    messages.sent.length = 0;

    const res = await api()
      .post(`/app/sos/${sos.id}/end`)
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
    expect(messages.sent[0].text).toContain('Priya Sharma has marked themselves safe');
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
      .post(`/app/sos/${sos.id}/end`)
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
      .post(`/app/sos/${sos.id}/end`)
      .set(bearer(token))
      .send({ reason: 'safe' })
      .expect(200);
    await api()
      .post(`/app/sos/${sos.id}/end`)
      .set(bearer(token))
      .send({ reason: 'safe' })
      .expect(200);
    expect(messages.sent).toHaveLength(1);
  });

  it("can't end another user's SOS", async () => {
    const sos = (await startSos().expect(200)).body as Sos;
    const other = await appUser(ctx, '+919812399999');
    await api()
      .post(`/app/sos/${sos.id}/end`)
      .set(bearer(other.token))
      .send({ reason: 'safe' })
      .expect(404);
  });

  it('a new SOS can start after the last one ended', async () => {
    const first = (await startSos().expect(200)).body as Sos;
    await api()
      .post(`/app/sos/${first.id}/end`)
      .set(bearer(token))
      .send({ reason: 'safe' })
      .expect(200);
    const second = (await startSos().expect(200)).body as Sos;
    expect(second.id).not.toBe(first.id);
  });
});

describe('POST /app/sos/cancelled and GET /app/sos/active', () => {
  it('saves a countdown cancel without alerts (admin History shows "Cancelled in the countdown")', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    messages.sent.length = 0;
    const id = randomUUID();
    const startedAt = new Date(Date.now() - 4000).toISOString();
    const body = { id, trigger: 'button', isTest: false, startedAt, cancelledAt: now() };
    await api().post('/app/sos/cancelled').set(bearer(token)).send(body).expect(204);
    await api().post('/app/sos/cancelled').set(bearer(token)).send(body).expect(204);

    const rows = await ctx.db.selectFrom('sos_events').select(['status', 'end_reason']).execute();
    expect(rows).toEqual([{ status: 'cancelled', end_reason: 'cancelled_in_countdown' }]);
    expect(messages.sent).toHaveLength(0);
    expect(await ctx.db.selectFrom('guardian_links').select('id').execute()).toHaveLength(0);
  });

  it('refuses a cancel time before the start time', async () => {
    await api()
      .post('/app/sos/cancelled')
      .set(bearer(token))
      .send({
        id: randomUUID(),
        trigger: 'button',
        isTest: false,
        startedAt: now(),
        cancelledAt: new Date(Date.now() - 10_000).toISOString(),
      })
      .expect(400);
  });

  it('active: 204 when none, the SOS when one is running', async () => {
    await api().get('/app/sos/active').set(bearer(token)).expect(204);
    const sos = (await startSos().expect(200)).body as Sos;
    const res = await api().get('/app/sos/active').set(bearer(token)).expect(200);
    expect((res.body as Sos).id).toBe(sos.id);
  });
});
