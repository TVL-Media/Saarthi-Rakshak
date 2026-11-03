import { randomUUID } from 'node:crypto';
import type { Guardian } from '@sarthi/shared';
import { sql } from 'kysely';
import { TestPushSender, PushSender } from '../src/app/alerts/push-sender';
import { SmsProviders, TestSmsProvider } from '../src/app/alerts/sms-providers';
import { hashLinkCode } from '../src/app/common/guardian-links';
import { BullJobQueue } from '../src/app/jobs/bull-job-queue';
import { JobHandlers, JobQueue } from '../src/app/jobs/job-queue';
import { ManualJobQueue } from '../src/app/jobs/manual-job-queue';
import { OutgoingMessages } from '../src/app/messages/outgoing-messages';
import { CleanupService } from '../src/app/timers/cleanup.service';
import { SafetyTimers } from '../src/app/timers/safety-timers.service';
import { activeConnections, validateEnv } from '../src/config/env.schema';
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
import { MAX_SMS_ATTEMPTS } from '../src/alerts/alerts.constants';
import { AlertsService } from '../src/alerts/alerts.service';
import { DashboardService } from '../src/dashboard/dashboard.service';

const WEBHOOK_SECRET = 'test-webhook-secret-0123456789';

let ctx: AppTestContext;
let messages: OutgoingMessages;
let jobs: ManualJobQueue;
let main: TestSmsProvider;
let backup: TestSmsProvider;
let push: TestPushSender;
let timers: SafetyTimers;
let token: string;
let userId: string;

beforeAll(async () => {
  process.env.SMS_WEBHOOK_SECRET = WEBHOOK_SECRET;
  ctx = await startAppTest();
  messages = ctx.app.get(OutgoingMessages);
  jobs = ctx.app.get<JobQueue, ManualJobQueue>(JobQueue);
  const providers = ctx.app.get(SmsProviders);
  main = providers.main as TestSmsProvider;
  backup = providers.backup as TestSmsProvider;
  push = ctx.app.get<PushSender, TestPushSender>(PushSender);
  timers = ctx.app.get(SafetyTimers);
});

beforeEach(async () => {
  await resetAppTest(ctx);
  jobs.clear();
  for (const p of [main, backup]) {
    p.sent.length = 0;
    p.failing = false;
  }
  push.sent.length = 0;
  push.invalidTokens.clear();
  ({ token, userId } = await appUser(ctx));
  await api().patch('/v1/me').set(bearer(token)).send({ name: 'Priya Sharma' });
  messages.sent.length = 0;
  messages.pushed.length = 0;
});

afterAll(async () => {
  delete process.env.SMS_WEBHOOK_SECRET;
  await stopAppTest(ctx);
});

const api = () => http(ctx);
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const MIN = 60_000;

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

async function startSos(extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  await api()
    .post('/v1/sos')
    .set(bearer(token))
    .send({ id, trigger: 'button', startedAt: new Date().toISOString(), ...extra })
    .expect(200);
  return id;
}

const alertRows = () =>
  ctx.db
    .selectFrom('alerts')
    .select([
      'type',
      'channel',
      'provider',
      'attempt',
      'status',
      'error',
      'body',
      'provider_message_id',
      'sos_event_id',
      'journey_id',
    ])
    .orderBy('created_at')
    .orderBy('attempt')
    .execute();

async function addPushToken(tokenValue = 'push-token-1') {
  await ctx.db
    .insertInto('devices')
    .values({ user_id: userId, model: 'Pixel', push_token: tokenValue })
    .execute();
}

describe('Sending SMS (main → backup → retries)', () => {
  it('saves an alert per SMS and sends it with the main provider', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    await jobs.run(); // the invite
    main.sent.length = 0;
    const sosId = await startSos();

    let rows = (await alertRows()).filter((r) => r.type === 'sos');
    expect(rows).toEqual([
      expect.objectContaining({ channel: 'sms', provider: 'main', attempt: 1, status: 'queued' }),
    ]);
    expect(rows[0].body).toContain('/l/');

    await jobs.run();
    rows = (await alertRows()).filter((r) => r.type === 'sos');
    expect(rows).toEqual([
      expect.objectContaining({ status: 'sent', body: null, sos_event_id: sosId }),
    ]);
    expect(rows[0].provider_message_id).toMatch(/^main-/);
    expect(main.sent).toEqual([expect.objectContaining({ phone: '+919800000001' })]);
    expect(main.sent[0].text).toContain('SOS from Priya Sharma');
  });

  it('tries the backup provider at once when the main one fails', async () => {
    await addGuardian('Ravi', '9800000001');
    main.failing = true;
    await jobs.run();

    expect(await alertRows()).toEqual([
      expect.objectContaining({ type: 'invite', provider: 'main', attempt: 1, status: 'failed' }),
      expect.objectContaining({ type: 'invite', provider: 'backup', attempt: 2, status: 'sent' }),
    ]);
    expect(backup.sent).toHaveLength(1);
  });

  it('retries after 30 seconds, then reports that all tries failed (MAX_SMS_ATTEMPTS)', async () => {
    await addGuardian('Ravi', '9800000001');
    main.failing = true;
    backup.failing = true;

    await jobs.run();
    expect(await alertRows()).toHaveLength(3); // try 3 waits 30 s
    await jobs.run(30_000);
    await jobs.run(3 * MIN);

    const rows = await alertRows();
    expect(MAX_SMS_ATTEMPTS).toBe(3);
    expect(rows.map((r) => [r.provider, r.attempt, r.status])).toEqual([
      ['main', 1, 'failed'],
      ['backup', 2, 'failed'],
      ['main', 3, 'failed'],
    ]);
    expect(rows[2].error).toContain('All tries failed.');
    expect(rows.every((r) => r.body === null)).toBe(true);
  });

  it('fails the SMS when the guardian no longer has a number', async () => {
    const ravi = await addGuardian('Ravi', '9800000001');
    await ctx.db
      .updateTable('guardians')
      .set({ phone: null, invite_status: 'declined' })
      .where('id', '=', ravi.id)
      .execute();
    await jobs.run();
    expect(await alertRows()).toEqual([
      expect.objectContaining({
        status: 'failed',
        error: 'The guardian has no phone number any more.',
      }),
    ]);
    expect(main.sent).toEqual([]);
  });

  it('records guardians reached by SIM SMS and sends them only the live link', async () => {
    const ravi = await addGuardian('Ravi', '9800000001', 'accept');
    await jobs.run();
    await ctx.db.deleteFrom('alerts').execute();
    await startSos({ simSmsSentTo: [ravi.id] });

    expect((await alertRows()).map((r) => [r.channel, r.type, r.status])).toEqual([
      ['sim_sms', 'sos', 'sent'],
      ['sms', 'sos_link', 'queued'],
    ]);
  });

  it('re-queues an SMS that never reached the queue', async () => {
    await addGuardian('Ravi', '9800000001');
    jobs.clear(); // as if Redis was down when it was saved
    await sql`UPDATE alerts SET created_at = now() - interval '10 minutes'`.execute(ctx.db);
    await timers.sweep();
    await jobs.runOnly('sms');
    expect((await alertRows())[0].status).toBe('sent');
  });
});

describe('Delivery reports', () => {
  async function sentInvite() {
    await addGuardian('Ravi', '9800000001');
    await jobs.run();
    return (await alertRows())[0].provider_message_id!;
  }

  it('marks the SMS delivered', async () => {
    const messageId = await sentInvite();
    await api()
      .post('/v1/webhooks/sms/main')
      .set('x-webhook-secret', WEBHOOK_SECRET)
      .send({ messageId, status: 'delivered' })
      .expect(204);
    const row = await ctx.db.selectFrom('alerts').selectAll().executeTakeFirstOrThrow();
    expect(row.status).toBe('delivered');
    expect(row.delivered_at).not.toBeNull();
  });

  it('marks it failed with the reason', async () => {
    const messageId = await sentInvite();
    await api()
      .post('/v1/webhooks/sms/main')
      .set('x-webhook-secret', WEBHOOK_SECRET)
      .send({ messageId, status: 'failed', error: 'Number switched off' })
      .expect(204);
    const row = await ctx.db.selectFrom('alerts').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'failed', error: 'Number switched off' });
  });

  it('refuses a wrong secret and an unknown provider', async () => {
    const messageId = await sentInvite();
    await api()
      .post('/v1/webhooks/sms/main')
      .set('x-webhook-secret', 'wrong')
      .send({ messageId, status: 'delivered' })
      .expect(401);
    await api()
      .post('/v1/webhooks/sms/other')
      .set('x-webhook-secret', WEBHOOK_SECRET)
      .send({ messageId, status: 'delivered' })
      .expect(404);
  });
});

describe('No guardian responded (SOS)', () => {
  it('reminds guardians once and pushes "Call 112" to the phone after 5 minutes', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    await addPushToken();
    const sosId = await startSos();
    await jobs.run();
    main.sent.length = 0;

    await jobs.run(4 * MIN);
    expect(main.sent).toEqual([]); // not yet

    await jobs.run(5 * MIN + 1000);
    expect(main.sent).toHaveLength(1);
    expect(main.sent[0].text).toMatch(
      /^REMINDER: Priya Sharma's SOS .* Live location: http.*\/l\//,
    );
    // The reminder carries the same live link as the first SMS.
    const code = /\/l\/([A-Za-z0-9_-]+)/.exec(main.sent[0].text)![1];
    const link = await ctx.db
      .selectFrom('guardian_links')
      .select('token_hash')
      .executeTakeFirstOrThrow();
    expect(hashLinkCode(code)).toBe(link.token_hash);

    expect(push.sent).toEqual([
      {
        token: 'push-token-1',
        message: expect.objectContaining({ type: 'show_call_112', data: { sosId } }) as unknown,
      },
    ]);

    // Only once.
    await timers.noResponse(sosId);
    await jobs.run();
    expect(main.sent).toHaveLength(1);
  });

  it('does nothing when a guardian is responding or the SOS ended', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    const sosId = await startSos();
    await ctx.db.updateTable('guardian_links').set({ responding_at: new Date() }).execute();
    await jobs.run(6 * MIN);
    expect((await alertRows()).some((r) => r.type === 'resend')).toBe(false);

    const second = await (async () => {
      await api().post(`/v1/sos/${sosId}/end`).set(bearer(token)).send({ reason: 'safe' });
      return startSos();
    })();
    await api().post(`/v1/sos/${second}/end`).set(bearer(token)).send({ reason: 'safe' });
    await jobs.run(6 * MIN);
    expect((await alertRows()).some((r) => r.type === 'resend')).toBe(false);
  });

  it('clears a push token the phone no longer has', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    await addPushToken('old-token');
    push.invalidTokens.add('old-token');
    await startSos();
    await jobs.run(6 * MIN);
    const device = await ctx.db
      .selectFrom('devices')
      .select('push_token')
      .executeTakeFirstOrThrow();
    expect(device.push_token).toBeNull();
  });
});

describe('Check-in not answered', () => {
  async function journeyWithCheckin() {
    await addGuardian('Ravi', '9800000001', 'accept');
    await addGuardian('Sita', '9800000002'); // not accepted: gets no journey messages
    const journeyId = randomUUID();
    await api()
      .post('/v1/journeys')
      .set(bearer(token))
      .send({
        id: journeyId,
        destination: { lat: 28.57, lng: 77.32, label: 'Home' },
        expectedArrivalAt: new Date(Date.now() + 40 * MIN).toISOString(),
      })
      .expect(200);
    const checkinId = randomUUID();
    await api()
      .post(`/v1/journeys/${journeyId}/checkins`)
      .set(bearer(token))
      .send({ id: checkinId, reason: 'stopped' })
      .expect(200);
    await jobs.run();
    main.sent.length = 0;
    return { journeyId, checkinId };
  }

  it('alerts accepted guardians after 2 minutes without an answer', async () => {
    const { checkinId } = await journeyWithCheckin();
    await jobs.run(2 * MIN + 1000);

    const checkin = await ctx.db
      .selectFrom('checkins')
      .select('status')
      .where('id', '=', checkinId)
      .executeTakeFirstOrThrow();
    expect(checkin.status).toBe('no_reply');
    expect(main.sent.map((m) => m.phone)).toEqual(['+919800000001']);
    expect(main.sent[0].text).toMatch(
      /Priya Sharma did not answer a safety check on the way to Home\. Live location: .*\/l\//,
    );
    expect(messages.pushed.map((p) => p.type)).toEqual(['checkin_no_reply']);
  });

  it('does nothing when the check-in was answered in time', async () => {
    const { checkinId } = await journeyWithCheckin();
    await api()
      .post(`/v1/checkins/${checkinId}/answer`)
      .set(bearer(token))
      .send({ answer: 'fine' })
      .expect(200);
    await jobs.run(3 * MIN);
    expect(main.sent).toEqual([]);
  });
});

describe('Lost contact', () => {
  it('tells guardians when the phone is silent for 5 minutes, and when it is back', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    const sosId = await startSos({ startedAt: minutesAgo(5.5) });
    jobs.clear(); // only the sweep in this test
    await ctx.db.deleteFrom('alerts').execute();

    await timers.sweep();
    await jobs.runOnly('sms');
    let rows = await alertRows();
    expect(rows.map((r) => [r.type, r.status])).toEqual([['lost_contact', 'sent']]);
    expect(main.sent.at(-1)!.text).toMatch(
      /^We lost contact with Priya Sharma's phone\. Last location at .*: http/,
    );
    const sos = await ctx.db
      .selectFrom('sos_events')
      .select('lost_contact_at')
      .executeTakeFirstOrThrow();
    expect(sos.lost_contact_at).not.toBeNull();

    // Once only while still silent.
    await timers.sweep();
    await jobs.runOnly('sms');
    expect(await alertRows()).toHaveLength(1);

    await api()
      .post('/v1/heartbeat')
      .set(bearer(token))
      .send({ sosId, batteryPct: 40 })
      .expect(204);
    await timers.sweep();
    await jobs.runOnly('sms');
    rows = await alertRows();
    expect(rows.map((r) => r.type)).toEqual(['lost_contact', 'back_online']);
    expect(main.sent.at(-1)!.text).toMatch(/^Priya Sharma's phone is back online\./);
  });

  it('leaves a phone alone while it keeps sending heartbeats', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    const sosId = await startSos({ startedAt: minutesAgo(10) });
    // A guardian is responding, so no "no response" reminder either.
    await ctx.db.updateTable('guardian_links').set({ responding_at: new Date() }).execute();
    await api().post('/v1/heartbeat').set(bearer(token)).send({ sosId }).expect(204);
    await ctx.db.deleteFrom('alerts').execute();
    jobs.clear();
    await timers.sweep();
    expect(await alertRows()).toEqual([]);
  });

  it('runs a missed "no response" timer from the sweep', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    const sosId = await startSos({ startedAt: minutesAgo(7) });
    await api().post('/v1/heartbeat').set(bearer(token)).send({ sosId }).expect(204);
    jobs.clear(); // the timer job was lost
    await timers.sweep();
    expect((await alertRows()).some((r) => r.type === 'resend')).toBe(true);
  });
});

describe('Hourly cleanup', () => {
  it('deletes audio past its date unless kept', async () => {
    const storage = ctx.app.get(StorageService);
    const sosId = await startSos();
    const keys = [
      `users/${userId}/audio/${sosId}/old.enc`,
      `users/${userId}/audio/${sosId}/kept.enc`,
    ];
    for (const key of keys) {
      const url = await storage.uploadUrl(key, 'application/octet-stream', 3);
      await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '3' },
        body: Buffer.from('abc'),
      });
    }
    const past = new Date(Date.now() - 86_400_000);
    await ctx.db
      .insertInto('media_clips')
      .values([
        { user_id: userId, sos_event_id: sosId, storage_key: keys[0], delete_after: past },
        {
          user_id: userId,
          sos_event_id: sosId,
          storage_key: keys[1],
          delete_after: past,
          keep: true,
        },
      ])
      .execute();

    const result = await ctx.app.get(CleanupService).run();
    expect(result.clips).toBe(1);
    expect(await storage.info(keys[0])).toBeNull();
    expect(await storage.info(keys[1])).not.toBeNull();
    const rows = await ctx.db
      .selectFrom('media_clips')
      .select(['storage_key', 'deleted_at'])
      .orderBy('keep')
      .execute();
    expect(rows[0].deleted_at).not.toBeNull();
    expect(rows[1].deleted_at).toBeNull();
    await storage.delete(keys[1]);
  });
});

describe('BullMQ queue (real Redis)', () => {
  it('runs a job added to the queue in the worker', async () => {
    const env = validateEnv(process.env);
    const handlers = new JobHandlers();
    let resolve!: (data: Record<string, unknown>) => void;
    const ran = new Promise<Record<string, unknown>>((r) => (resolve = r));
    handlers.register('sms', (data) => {
      resolve(data);
      return Promise.resolve();
    });
    handlers.register('lost-contact-sweep', () => Promise.resolve());
    handlers.register('cleanup', () => Promise.resolve());
    const queue = new BullJobQueue(activeConnections(env).redisUrl, handlers);
    try {
      await queue.startWorker();
      await queue.add('sms', { alertId: 'abc' }, { jobId: 'sms-test-1' });
      await expect(ran).resolves.toEqual({ alertId: 'abc' });
    } finally {
      await queue.close();
    }
  });
});

// The admin Alert Log and Dashboard read what this worker writes: they must agree with it.
describe('Admin screens see what the worker did', () => {
  it('Alert Log and Dashboard show "all tries failed" after the last (main) try', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    await jobs.run();
    await ctx.db.deleteFrom('alerts').execute();
    main.failing = true;
    backup.failing = true;
    await startSos();
    await jobs.run();
    await jobs.run(30_000);

    const { rows } = await ctx.app.get(AlertsService).list();
    const sms = rows.filter((r) => r.channel === 'sms').sort((a, b) => a.attempt - b.attempt);
    expect(sms.map((r) => [r.provider, r.attempt, r.nextStep])).toEqual([
      ['main', 1, 'retry_backup'],
      ['backup', 2, 'retrying'],
      ['main', MAX_SMS_ATTEMPTS, 'all_failed'],
    ]);
    const summary = await ctx.app.get(DashboardService).summary();
    expect(summary.attention.map((a) => a.kind)).toContain('sms_all_failed');
  });

  it('Dashboard lists a journey whose phone went silent (journey stays active)', async () => {
    await addGuardian('Ravi', '9800000001', 'accept');
    const journeyId = randomUUID();
    await api()
      .post('/v1/journeys')
      .set(bearer(token))
      .send({
        id: journeyId,
        destination: { lat: 28.57, lng: 77.32, label: 'Home' },
        expectedArrivalAt: new Date(Date.now() + 40 * MIN).toISOString(),
      })
      .expect(200);
    await ctx.db
      .updateTable('journeys')
      .set({ started_at: new Date(minutesAgo(6)) })
      .where('id', '=', journeyId)
      .execute();
    jobs.clear();
    await timers.sweep();
    await jobs.runOnly('sms');

    const journey = await ctx.db
      .selectFrom('journeys')
      .select(['status', 'lost_contact_at'])
      .where('id', '=', journeyId)
      .executeTakeFirstOrThrow();
    expect(journey.status).toBe('active');
    expect(journey.lost_contact_at).not.toBeNull();
    const summary = await ctx.app.get(DashboardService).summary();
    expect(summary.attention).toContainEqual(
      expect.objectContaining({ kind: 'journey_lost_contact', journeyId }),
    );
  });
});
