import { randomUUID } from 'node:crypto';
import type { Checkin, Guardian, Journey, Sos } from '@sarthi/shared';
import { FINE_QUIET_MINUTES } from '../src/app/journeys/journeys.service';
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

beforeAll(async () => {
  ctx = await startAppTest();
  messages = ctx.app.get(OutgoingMessages);
});

beforeEach(async () => {
  await resetAppTest(ctx);
  ({ token } = await appUser(ctx));
  await api().patch('/v1/me').set(bearer(token)).send({ name: 'Priya Sharma' });
  messages.sent.length = 0;
});

afterAll(() => stopAppTest(ctx));

const api = () => http(ctx);
const errorOf = (body: unknown) => (body as { error: string }).error;
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

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

function start(extra: Record<string, unknown> = {}) {
  return api()
    .post('/v1/journeys')
    .set(bearer(token))
    .send({
      id: randomUUID(),
      destination: { lat: 28.5706, lng: 77.3272, label: 'Home' },
      expectedArrivalAt: inMinutes(40),
      route: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
      ...extra,
    });
}

const raise = (journeyId: string, reason = 'stopped', id = randomUUID()) =>
  api().post(`/v1/journeys/${journeyId}/checkins`).set(bearer(token)).send({ id, reason });
const answer = (checkinId: string, a: string) =>
  api().post(`/v1/checkins/${checkinId}/answer`).set(bearer(token)).send({ answer: a });

describe('POST /v1/journeys', () => {
  it('starts a journey with a copy of the rules and sends accepted guardians a live link', async () => {
    const ravi = await addGuardian('Ravi', '9800000001', 'accept');
    await addGuardian('Sita', '9800000002'); // not answered: no journey messages
    await addGuardian('Amit', '9800000003', 'decline');
    messages.sent.length = 0;

    const res = await start().expect(200);
    const journey = res.body as Journey;
    expect(journey).toMatchObject({
      status: 'active',
      destination: { lat: 28.5706, lng: 77.3272, label: 'Home' },
      endedAt: null,
      openCheckin: null,
      checkinsPausedUntil: null,
      route: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
    });

    const row = await ctx.db.selectFrom('journeys').select('rules').executeTakeFirstOrThrow();
    expect(row.rules).toMatchObject({ 'checkin.traffic_pause_minutes': 10 });
    const links = await ctx.db
      .selectFrom('guardian_links')
      .select(['guardian_id', 'journey_id'])
      .execute();
    expect(links).toEqual([{ guardian_id: ravi.id, journey_id: journey.id }]);

    expect(messages.sent).toHaveLength(1);
    expect(messages.sent[0]).toMatchObject({ guardianId: ravi.id, kind: 'journey_started' });
    expect(messages.sent[0].text).toMatch(
      /^Priya Sharma started a journey to Home, arriving \d{1,2}:\d{2} (am|pm)\. Follow: http:\/\/localhost:5175\/l\/[A-Za-z0-9_-]{30,}$/,
    );
  });

  it('the same id twice gives one journey and one set of messages', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    messages.sent.length = 0;
    const id = randomUUID();
    await start({ id }).expect(200);
    await start({ id }).expect(200);
    expect(await ctx.db.selectFrom('journeys').select('id').execute()).toHaveLength(1);
    expect(messages.sent).toHaveLength(1);
  });

  it('refuses a second journey while one is on', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    await start().expect(200);
    expect(errorOf((await start().expect(409)).body)).toBe('conflict');
  });

  it('needs at least one accepted guardian', async () => {
    await addGuardian('Sita', '9800000002');
    expect(errorOf((await start().expect(409)).body)).toBe('conflict');
  });

  it('arrival must be between 5 minutes and 12 hours from now', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    await start({ expectedArrivalAt: inMinutes(2) }).expect(400);
    await start({ expectedArrivalAt: inMinutes(13 * 60) }).expect(400);
    await start({ expectedArrivalAt: inMinutes(6) }).expect(200);
  });

  it('active: 204 when none, the journey when one is on', async () => {
    await api().get('/v1/journeys/active').set(bearer(token)).expect(204);
    await addGuardian('Ravi', '9800000001', 'accept');
    const journey = (await start().expect(200)).body as Journey;
    const res = await api().get('/v1/journeys/active').set(bearer(token)).expect(200);
    expect((res.body as Journey).id).toBe(journey.id);
  });
});

describe('POST /v1/journeys/:id/end', () => {
  let journey: Journey;
  beforeEach(async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    journey = (await start().expect(200)).body as Journey;
    messages.sent.length = 0;
  });

  it('"I reached safely" tells guardians and keeps the link open for the copied minutes', async () => {
    const res = await api()
      .post(`/v1/journeys/${journey.id}/end`)
      .set(bearer(token))
      .send({ outcome: 'arrived' })
      .expect(200);
    expect(res.body).toMatchObject({ status: 'arrived', endedAt: expect.any(String) as unknown });
    expect(messages.sent.map((m) => [m.kind, m.text])).toEqual([
      ['journey_arrived', 'Priya Sharma reached Home safely.'],
    ]);
    const link = await ctx.db
      .selectFrom('guardian_links')
      .select('expires_at')
      .executeTakeFirstOrThrow();
    const minutesLeft = (new Date(link.expires_at).getTime() - Date.now()) / 60_000;
    expect(minutesLeft).toBeGreaterThan(14);
    expect(minutesLeft).toBeLessThanOrEqual(15);
  });

  it('"End journey" sends the ended message; ending twice tells guardians once', async () => {
    await api()
      .post(`/v1/journeys/${journey.id}/end`)
      .set(bearer(token))
      .send({ outcome: 'ended' })
      .expect(200);
    await api()
      .post(`/v1/journeys/${journey.id}/end`)
      .set(bearer(token))
      .send({ outcome: 'ended' })
      .expect(200);
    expect(messages.sent.map((m) => m.text)).toEqual(['Priya Sharma ended the journey to Home.']);
  });

  it('closes a check-in still waiting, and a new journey can start', async () => {
    const checkin = (await raise(journey.id).expect(200)).body as Checkin;
    await api()
      .post(`/v1/journeys/${journey.id}/end`)
      .set(bearer(token))
      .send({ outcome: 'arrived' })
      .expect(200);
    const row = await ctx.db
      .selectFrom('checkins')
      .select('status')
      .where('id', '=', checkin.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('fine');
    await start().expect(200);
  });

  it("can't end another user's journey", async () => {
    const other = await appUser(ctx, '+919812399999');
    await api()
      .post(`/v1/journeys/${journey.id}/end`)
      .set(bearer(other.token))
      .send({ outcome: 'arrived' })
      .expect(404);
  });

  it('location points can be sent for the journey', async () => {
    await api()
      .post('/v1/locations')
      .set(bearer(token))
      .send({
        points: [
          {
            clientPointId: randomUUID(),
            journeyId: journey.id,
            lat: 28.57,
            lng: 77.32,
            recordedAt: new Date().toISOString(),
          },
        ],
      })
      .expect(200);
  });
});

describe('Check-ins', () => {
  let journey: Journey;
  beforeEach(async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    journey = (await start().expect(200)).body as Journey;
  });

  it('the phone raises a check-in; the journey shows it as open', async () => {
    const res = await raise(journey.id, 'off_route').expect(200);
    expect(res.body).toMatchObject({ reason: 'off_route', source: 'phone', status: 'pending' });
    const j = await api().get(`/v1/journeys/${journey.id}`).set(bearer(token)).expect(200);
    expect((j.body as Journey).openCheckin).toMatchObject({ reason: 'off_route' });
  });

  it('the same id twice gives one check-in; a second while one waits returns the waiting one', async () => {
    const id = randomUUID();
    const a = (await raise(journey.id, 'stopped', id).expect(200)).body as Checkin;
    const b = (await raise(journey.id, 'stopped', id).expect(200)).body as Checkin;
    const c = (await raise(journey.id, 'late').expect(200)).body as Checkin;
    expect(b.id).toBe(a.id);
    expect(c.id).toBe(a.id);
    expect(await ctx.db.selectFrom('checkins').select('id').execute()).toHaveLength(1);
  });

  it(`"I'm fine" closes it; the same reason is not asked again for ${FINE_QUIET_MINUTES} minutes`, async () => {
    const c = (await raise(journey.id, 'stopped').expect(200)).body as Checkin;
    expect((await answer(c.id, 'fine').expect(200)).body).toMatchObject({ status: 'fine' });
    expect(errorOf((await raise(journey.id, 'stopped').expect(409)).body)).toBe('conflict');
    const late = (await raise(journey.id, 'late').expect(200)).body as Checkin; // other reasons still asked
    await answer(late.id, 'traffic_pause').expect(200);
    await ctx.db.updateTable('journeys').set({ checkins_paused_until: null }).execute();

    await ctx.db
      .updateTable('checkins')
      .set({ answered_at: new Date(Date.now() - (FINE_QUIET_MINUTES + 1) * 60_000) })
      .where('id', '=', c.id)
      .execute();
    expect((await raise(journey.id, 'stopped').expect(200)).body).toMatchObject({
      reason: 'stopped',
      status: 'pending',
    });
  });

  it('"Stuck in traffic" pauses check-ins for 10 minutes (copied setting)', async () => {
    const c = (await raise(journey.id).expect(200)).body as Checkin;
    await answer(c.id, 'traffic_pause').expect(200);
    const j = (await api().get(`/v1/journeys/${journey.id}`).set(bearer(token)).expect(200))
      .body as Journey;
    const minutes = (Date.parse(j.checkinsPausedUntil!) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9);
    expect(minutes).toBeLessThanOrEqual(10);
    expect(errorOf((await raise(journey.id, 'late').expect(409)).body)).toBe('conflict');

    await ctx.db
      .updateTable('journeys')
      .set({ checkins_paused_until: new Date(Date.now() - 1000) })
      .execute();
    await raise(journey.id, 'late').expect(200);
  });

  it('"I need help" is recorded; the app then starts an SOS linked to the journey', async () => {
    const c = (await raise(journey.id).expect(200)).body as Checkin;
    await answer(c.id, 'sos').expect(200);
    const sos = await api()
      .post('/v1/sos')
      .set(bearer(token))
      .send({
        id: randomUUID(),
        trigger: 'checkin',
        startedAt: new Date().toISOString(),
        journeyId: journey.id,
      })
      .expect(200);
    expect((sos.body as Sos).trigger).toBe('checkin');
  });

  it('a late answer after "no reply" is still recorded; an answered one cannot change', async () => {
    const c = (await raise(journey.id).expect(200)).body as Checkin;
    await ctx.db.updateTable('checkins').set({ status: 'no_reply' }).execute();
    await answer(c.id, 'fine').expect(200);
    await answer(c.id, 'fine').expect(200);
    expect(errorOf((await answer(c.id, 'sos').expect(409)).body)).toBe('conflict');
  });

  it("refuses check-ins on an ended journey and on someone else's", async () => {
    const other = await appUser(ctx, '+919812399999');
    await api()
      .post(`/v1/journeys/${journey.id}/checkins`)
      .set(bearer(other.token))
      .send({ id: randomUUID(), reason: 'stopped' })
      .expect(404);
    await api()
      .post(`/v1/journeys/${journey.id}/end`)
      .set(bearer(token))
      .send({ outcome: 'ended' })
      .expect(200);
    await raise(journey.id).expect(409);
  });

  it('refuses an unknown answer', async () => {
    const c = (await raise(journey.id).expect(200)).body as Checkin;
    await answer(c.id, 'traffic').expect(400);
  });
});
