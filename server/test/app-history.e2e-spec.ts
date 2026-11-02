import { randomUUID } from 'node:crypto';
import type { Guardian, HistoryDetail, HistoryPage, Journey, Sos } from '@sarthi/shared';
import { sql } from 'kysely';
import { HISTORY_PAGE_SIZE } from '../src/app/history/history.service';
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
  await api().patch('/v1/me').set(bearer(token)).send({ name: 'Priya Sharma' });
  messages.sent.length = 0;
});

afterAll(() => stopAppTest(ctx));

const api = () => http(ctx);
const errorOf = (body: unknown) => (body as { error: string }).error;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

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

async function sos(startedAt = new Date().toISOString()) {
  const res = await api()
    .post('/v1/sos')
    .set(bearer(token))
    .send({ id: randomUUID(), trigger: 'button', startedAt })
    .expect(200);
  return res.body as Sos;
}

async function journey() {
  const res = await api()
    .post('/v1/journeys')
    .set(bearer(token))
    .send({
      id: randomUUID(),
      destination: { lat: 28.5706, lng: 77.3272, label: 'Home' },
      expectedArrivalAt: new Date(Date.now() + 40 * 60_000).toISOString(),
    })
    .expect(200);
  return res.body as Journey;
}

const history = (query = '') => api().get(`/v1/history${query}`).set(bearer(token)).expect(200);

describe('GET /v1/history', () => {
  it('is empty for a new user', async () => {
    const res = await history();
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  it('lists SOS events and journeys, newest first, with a type filter', async () => {
    await addGuardian('Ravi', '9800000001');
    const first = await sos(minutesAgo(30));
    await api()
      .post(`/v1/sos/${first.id}/end`)
      .set(bearer(token))
      .send({ reason: 'safe' })
      .expect(200);
    const trip = await journey();
    await api()
      .post(`/v1/journeys/${trip.id}/end`)
      .set(bearer(token))
      .send({ outcome: 'arrived' })
      .expect(200);

    const all = (await history()).body as HistoryPage;
    expect(all.items).toEqual([
      expect.objectContaining({
        type: 'journey',
        id: trip.id,
        status: 'arrived',
        isTest: false,
        trigger: null,
        destinationLabel: 'Home',
      }),
      expect.objectContaining({
        type: 'sos',
        id: first.id,
        status: 'ended',
        trigger: 'button',
        destinationLabel: null,
      }),
    ]);
    expect(all.items[1].endedAt).not.toBeNull();

    const onlySos = (await history('?type=sos')).body as HistoryPage;
    expect(onlySos.items.map((i) => i.id)).toEqual([first.id]);
    const onlyJourneys = (await history('?type=journey')).body as HistoryPage;
    expect(onlyJourneys.items.map((i) => i.id)).toEqual([trip.id]);
  });

  it('pages 20 at a time without skipping or repeating, even with equal start times', async () => {
    const same = new Date(Date.now() - 3600_000);
    const ids: string[] = [];
    for (let i = 0; i < HISTORY_PAGE_SIZE + 5; i++) {
      const id = randomUUID();
      ids.push(id);
      await ctx.db
        .insertInto('sos_events')
        .values({
          id,
          user_id: userId,
          trigger: 'button',
          status: 'cancelled',
          // Five share the exact same time.
          started_at: i < 5 ? same : new Date(same.getTime() - i * 1000),
        })
        .execute();
    }

    const page1 = (await history()).body as HistoryPage;
    expect(page1.items).toHaveLength(HISTORY_PAGE_SIZE);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = (await history(`?cursor=${page1.nextCursor}`)).body as HistoryPage;
    expect(page2.items).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();

    const seen = [...page1.items, ...page2.items].map((i) => i.id);
    expect(new Set(seen).size).toBe(ids.length);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('shows only the user’s own items', async () => {
    await sos();
    const other = await appUser(ctx, '+919800000099');
    const res = await api().get('/v1/history').set(bearer(other.token)).expect(200);
    expect((res.body as HistoryPage).items).toEqual([]);
  });

  it('refuses a broken cursor or unknown type', async () => {
    const bad = await api().get('/v1/history?cursor=abc').set(bearer(token)).expect(400);
    expect(errorOf(bad.body)).toBe('invalid_input');
    await api().get('/v1/history?type=fake').set(bearer(token)).expect(400);
  });

  it('needs login', async () => {
    await api().get('/v1/history').expect(401);
  });
});

describe('GET /v1/history/sos/:id', () => {
  it('shows the SOS timeline: started, alerted, opened, responding, ended', async () => {
    const ravi = await addGuardian('Ravi', '9800000001');
    const s = await sos();
    await ctx.db
      .updateTable('guardian_links')
      .set({
        opened_at: sql<Date>`now() + interval '1 second'`,
        responding_at: sql<Date>`now() + interval '2 seconds'`,
      })
      .where('guardian_id', '=', ravi.id)
      .execute();
    await new Promise((r) => setTimeout(r, 2100));
    await api().post(`/v1/sos/${s.id}/end`).set(bearer(token)).send({ reason: 'safe' }).expect(200);

    const res = await api().get(`/v1/history/sos/${s.id}`).set(bearer(token)).expect(200);
    const detail = res.body as HistoryDetail;
    expect(detail.item).toMatchObject({ type: 'sos', id: s.id, status: 'ended' });
    expect(detail.timeline.map((t) => [t.kind, t.text])).toEqual([
      ['sos_started', 'SOS started'],
      ['guardian_alerted', 'Alert sent to Ravi'],
      ['link_opened', 'Ravi opened the live link'],
      ['guardian_responding', 'Ravi is responding'],
      ['sos_ended', 'You marked yourself safe'],
    ]);
    expect(detail.clips).toEqual([]);
  });

  it('lists audio clips that are not deleted', async () => {
    const s = await sos();
    const deleteAfter = new Date(Date.now() + 30 * 86_400_000);
    await ctx.db
      .insertInto('media_clips')
      .values([
        {
          user_id: userId,
          sos_event_id: s.id,
          storage_key: 'a/1',
          duration_s: 30,
          delete_after: deleteAfter,
        },
        {
          user_id: userId,
          sos_event_id: s.id,
          storage_key: 'a/2',
          delete_after: deleteAfter,
          deleted_at: new Date(),
        },
      ])
      .execute();
    const res = await api().get(`/v1/history/sos/${s.id}`).set(bearer(token)).expect(200);
    expect((res.body as HistoryDetail).clips).toEqual([
      expect.objectContaining({
        durationS: 30,
        keep: false,
        deleteAfter: deleteAfter.toISOString(),
      }),
    ]);
  });

  it('shows a countdown cancel as one line', async () => {
    const id = randomUUID();
    await api()
      .post('/v1/sos/cancelled')
      .set(bearer(token))
      .send({
        id,
        trigger: 'button',
        startedAt: minutesAgo(1),
        cancelledAt: new Date().toISOString(),
      })
      .expect(204);
    const res = await api().get(`/v1/history/sos/${id}`).set(bearer(token)).expect(200);
    expect((res.body as HistoryDetail).timeline.map((t) => t.kind)).toEqual(['sos_cancelled']);
  });

  it('is not found for another user’s SOS or a bad id', async () => {
    const s = await sos();
    const other = await appUser(ctx, '+919800000099');
    await api().get(`/v1/history/sos/${s.id}`).set(bearer(other.token)).expect(404);
    await api().get('/v1/history/sos/not-a-uuid').set(bearer(token)).expect(404);
  });
});

describe('GET /v1/history/journeys/:id', () => {
  it('shows the journey timeline with check-ins', async () => {
    await addGuardian('Ravi', '9800000001');
    const trip = await journey();
    const checkinId = randomUUID();
    await api()
      .post(`/v1/journeys/${trip.id}/checkins`)
      .set(bearer(token))
      .send({ id: checkinId, reason: 'stopped' })
      .expect(200);
    await api()
      .post(`/v1/checkins/${checkinId}/answer`)
      .set(bearer(token))
      .send({ answer: 'fine' })
      .expect(200);
    await api()
      .post(`/v1/journeys/${trip.id}/end`)
      .set(bearer(token))
      .send({ outcome: 'arrived' })
      .expect(200);

    const res = await api().get(`/v1/history/journeys/${trip.id}`).set(bearer(token)).expect(200);
    const detail = res.body as HistoryDetail;
    expect(detail.item).toMatchObject({
      type: 'journey',
      status: 'arrived',
      destinationLabel: 'Home',
    });
    expect(detail.timeline.map((t) => t.text)).toEqual([
      'Journey to Home started',
      'Journey link sent to Ravi',
      'Check-in: stopped for too long',
      'You answered “I’m fine”',
      'You reached Home safely',
    ]);
  });

  it('is not found for another user’s journey', async () => {
    await addGuardian('Ravi', '9800000001');
    const trip = await journey();
    const other = await appUser(ctx, '+919800000099');
    const res = await api()
      .get(`/v1/history/journeys/${trip.id}`)
      .set(bearer(other.token))
      .expect(404);
    expect(errorOf(res.body)).toBe('not_found');
  });
});
