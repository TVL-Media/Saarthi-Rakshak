import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LivePoint, LiveView } from '@sarthi/shared';
import { io, type Socket } from 'socket.io-client';
import { JobQueue } from '../src/app/jobs/job-queue';
import { ManualJobQueue } from '../src/app/jobs/manual-job-queue';
import { LIVE_SOCKET_PATH } from '../src/app/live/live.gateway';
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
let jobs: ManualJobQueue;
let token: string;
let baseUrl: string;

beforeAll(async () => {
  ctx = await startAppTest();
  await ctx.app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${((ctx.app.getHttpServer() as Server).address() as AddressInfo).port}`;
  messages = ctx.app.get(OutgoingMessages);
  jobs = ctx.app.get<JobQueue, ManualJobQueue>(JobQueue);
});

beforeEach(async () => {
  await resetAppTest(ctx);
  jobs.clear();
  ({ token } = await appUser(ctx));
  await api().patch('/v1/me').set(bearer(token)).send({ name: 'Priya Sharma', bloodGroup: 'B+' });
  messages.sent.length = 0;
  messages.pushed.length = 0;
});

afterAll(() => stopAppTest(ctx));

const api = () => http(ctx);
const errorOf = (body: unknown) => (body as { error: string }).error;

async function addGuardian(name: string, phone: string, answer?: 'accept') {
  await api().post('/v1/guardians').set(bearer(token)).send({ name, phone }).expect(201);
  const code = /\/i\/([A-Za-z0-9_-]+)/.exec(messages.sent.at(-1)!.text)![1];
  if (answer) await api().post(`/g/i/${code}/${answer}`).expect(204);
}

/** The live-link code in the last SMS of a kind. */
const linkCode = (kind: string, index = 0) => {
  const sms = messages.sent.filter((m) => m.kind === kind)[index];
  return /\/l\/([A-Za-z0-9_-]+)/.exec(sms.text)![1];
};

async function startSos() {
  const id = randomUUID();
  await api()
    .post('/v1/sos')
    .set(bearer(token))
    .send({
      id,
      trigger: 'button',
      startedAt: new Date().toISOString(),
      location: { lat: 28.5706, lng: 77.3272, accuracyM: 8 },
    })
    .expect(200);
  return id;
}

async function startJourney() {
  const id = randomUUID();
  await api()
    .post('/v1/journeys')
    .set(bearer(token))
    .send({
      id,
      destination: { lat: 28.62, lng: 77.36, label: 'Home' },
      expectedArrivalAt: new Date(Date.now() + 40 * 60_000).toISOString(),
      route: '_p~iF~ps|U_ulLnnqC',
    })
    .expect(200);
  return id;
}

const view = (code: string) => api().get(`/g/l/${code}`);

describe('GET /g/l/:code (SOS)', () => {
  it('shows the SOS to the guardian and records that the link was opened', async () => {
    await addGuardian('Ravi Kumar', '9800000001', 'accept');
    await addGuardian('Sita', '9800000002');
    const sosId = await startSos();
    const code = linkCode('sos');

    const res = await view(code).expect(200);
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    const live = res.body as LiveView;
    expect(live).toMatchObject({
      kind: 'sos',
      status: 'active',
      outcome: null,
      person: { firstName: 'Priya', phone: '+919812344521', bloodGroup: 'B+' },
      location: { sosId, lat: 28.5706, lng: 77.3272, accuracyM: 8 },
      lostContact: false,
      journey: null,
      youAreResponding: false,
      guardians: [
        { firstName: 'Ravi', status: 'opened', isYou: true },
        { firstName: 'Sita', status: 'alerted', isYou: false },
      ],
    });
    expect(messages.pushed).toEqual([
      expect.objectContaining({
        type: 'guardian_status',
        title: 'Ravi opened your live link',
        data: expect.objectContaining({ sosId, status: 'opened' }) as unknown,
      }),
    ]);

    // Opening again is not reported again.
    await view(code).expect(200);
    expect(messages.pushed).toHaveLength(1);
  });

  it('shows the newest location point and battery', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    const sosId = await startSos();
    await api()
      .post('/v1/locations')
      .set(bearer(token))
      .send({
        points: [
          {
            clientPointId: randomUUID(),
            sosId,
            lat: 28.58,
            lng: 77.33,
            batteryPct: 61,
            recordedAt: new Date().toISOString(),
          },
        ],
      })
      .expect(200);
    const live = (await view(linkCode('sos')).expect(200)).body as LiveView;
    expect(live.location).toMatchObject({ lat: 28.58, lng: 77.33, batteryPct: 61 });
    expect(live.batteryPct).toBe(61);
  });

  it('"I\'m responding" shows to everyone and tells the user', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    await addGuardian('Sita', '9800000002', 'accept');
    const sosId = await startSos();
    const res = await api()
      .post(`/g/l/${linkCode('sos', 1)}/responding`)
      .expect(200);
    expect((res.body as LiveView).youAreResponding).toBe(true);
    expect(messages.pushed.map((p) => p.title)).toContain('Sita is responding');

    const ravi = (await view(linkCode('sos', 0)).expect(200)).body as LiveView;
    expect(ravi.guardians.map((g) => [g.firstName, g.status])).toEqual([
      ['Ravi', 'opened'],
      ['Sita', 'responding'],
    ]);

    // The "no guardian responded" reminder no longer goes out.
    await jobs.run(6 * 60_000);
    const resends = await ctx.db
      .selectFrom('alerts')
      .select('id')
      .where('type', '=', 'resend')
      .where('sos_event_id', '=', sosId)
      .execute();
    expect(resends).toEqual([]);
  });

  it('shows "safe" after the end, then the link expires', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    const sosId = await startSos();
    const code = linkCode('sos');
    await api()
      .post(`/v1/sos/${sosId}/end`)
      .set(bearer(token))
      .send({ reason: 'safe' })
      .expect(200);

    const live = (await view(code).expect(200)).body as LiveView;
    expect(live).toMatchObject({ status: 'ended', outcome: 'safe' });
    const res = await api().post(`/g/l/${code}/responding`).expect(409);
    expect(errorOf(res.body)).toBe('conflict');

    await ctx.db
      .updateTable('guardian_links')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .execute();
    const gone = await view(code).expect(410);
    expect(gone.body).toEqual({ error: 'link_expired', message: 'This alert has ended.' });
  });

  it('treats unknown or malformed codes like expired links', async () => {
    await view('x'.repeat(43)).expect(410);
    await view('bad!code').expect(410);
  });
});

describe('GET /g/l/:code (journey)', () => {
  it('shows the journey without phone number or blood group; no "responding"', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    await startJourney();
    const code = linkCode('journey_started');
    const live = (await view(code).expect(200)).body as LiveView;
    expect(live).toMatchObject({
      kind: 'journey',
      status: 'active',
      person: { firstName: 'Priya', phone: null, bloodGroup: null },
      location: null,
      journey: {
        destinationLabel: 'Home',
        destination: { lat: 28.62, lng: 77.36 },
        route: '_p~iF~ps|U_ulLnnqC',
      },
    });
    await api().post(`/g/l/${code}/responding`).expect(409);
  });

  it('shows "arrived" after "I reached safely"', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    const id = await startJourney();
    const code = linkCode('journey_started');
    await api()
      .post(`/v1/journeys/${id}/end`)
      .set(bearer(token))
      .send({ outcome: 'arrived' })
      .expect(200);
    const live = (await view(code).expect(200)).body as LiveView;
    expect(live).toMatchObject({ status: 'ended', outcome: 'arrived' });
  });
});

describe('Live updates (Socket.IO)', () => {
  const sockets: Socket[] = [];
  afterEach(() => {
    for (const s of sockets.splice(0)) s.disconnect();
  });

  function connect(code: string): Socket {
    const socket = io(baseUrl, {
      path: LIVE_SOCKET_PATH,
      auth: { code },
      transports: ['websocket'],
      reconnection: false,
    });
    sockets.push(socket);
    return socket;
  }

  const next = <T>(socket: Socket, event: string) =>
    new Promise<T>((resolve) => socket.once(event, (data: T) => resolve(data)));

  it('sends new locations and changes to the guardian page', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    const sosId = await startSos();
    const socket = connect(linkCode('sos'));
    await next(socket, 'ready');

    const location = next<LivePoint>(socket, 'location');
    await api()
      .post('/v1/locations')
      .set(bearer(token))
      .send({
        points: [
          {
            clientPointId: randomUUID(),
            sosId,
            lat: 28.59,
            lng: 77.34,
            recordedAt: new Date().toISOString(),
          },
        ],
      })
      .expect(200);
    await expect(location).resolves.toMatchObject({ sosId, lat: 28.59, lng: 77.34 });

    const changed = next(socket, 'changed');
    await api()
      .post(`/v1/sos/${sosId}/end`)
      .set(bearer(token))
      .send({ reason: 'safe' })
      .expect(200);
    await changed;
  });

  it('turns away a link that does not work', async () => {
    const socket = connect('y'.repeat(43));
    await next(socket, 'ended');
  });
});
