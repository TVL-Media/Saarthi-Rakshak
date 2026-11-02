import { randomUUID } from 'node:crypto';
import type { AudioClip, ClipLink, HistoryDetail, UploadLink } from '@sarthi/shared';
import { CLIP_TYPE, clipKey } from '../src/app/audio/audio.service';
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
let sosId: string;
const keys: string[] = [];

beforeAll(async () => {
  ctx = await startAppTest();
  storage = ctx.app.get(StorageService);
});

beforeEach(async () => {
  await resetAppTest(ctx);
  ({ token, userId } = await appUser(ctx));
  sosId = randomUUID();
  await api()
    .post('/v1/sos')
    .set(bearer(token))
    .send({ id: sosId, trigger: 'button', startedAt: new Date(Date.now() - 60_000).toISOString() })
    .expect(200);
});

afterEach(async () => {
  await Promise.all(keys.splice(0).map((k) => storage.delete(k)));
});

afterAll(() => stopAppTest(ctx));

const api = () => http(ctx);
const errorOf = (body: unknown) => (body as { error: string }).error;

async function upload(clipId: string, body = Buffer.alloc(1000, 7), forSos = sosId) {
  const res = await api()
    .post(`/v1/sos/${forSos}/audio-upload`)
    .set(bearer(token))
    .send({ clipId, sizeBytes: body.length })
    .expect(200);
  const link = res.body as UploadLink;
  keys.push(link.key);
  const put = await fetch(link.uploadUrl, { method: 'PUT', headers: link.headers, body });
  expect(put.status).toBe(200);
  return link;
}

const save = (clipId: string, extra: Record<string, unknown> = {}) =>
  api()
    .post(`/v1/sos/${sosId}/audio`)
    .set(bearer(token))
    .send({ clipId, recordedAt: new Date().toISOString(), durationS: 30, ...extra });

describe('SOS audio', () => {
  it('uploads, records, lists, plays and keeps a clip', async () => {
    const clipId = randomUUID();
    const link = await upload(clipId);
    expect(link.key).toBe(clipKey(userId, sosId, clipId));
    expect(link.headers['Content-Type']).toBe(CLIP_TYPE);

    const res = await save(clipId).expect(200);
    const clip = res.body as AudioClip;
    expect(clip).toMatchObject({ id: clipId, durationS: 30, keep: false });
    // Deleted after the 30 days in the rules copied onto the SOS.
    const days = (Date.parse(clip.deleteAfter) - Date.parse(clip.recordedAt)) / 86_400_000;
    expect(days).toBe(30);

    // Saving again is safe.
    expect((await save(clipId).expect(200)).body).toEqual(clip);

    const detail = (await api().get(`/v1/history/sos/${sosId}`).set(bearer(token)).expect(200))
      .body as HistoryDetail;
    expect(detail.clips).toEqual([clip]);

    const play = (await api().get(`/v1/audio/${clipId}/play`).set(bearer(token)).expect(200))
      .body as ClipLink;
    const file = await fetch(play.url);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(Buffer.alloc(1000, 7));

    const kept = await api().patch(`/v1/audio/${clipId}`).set(bearer(token)).send({ keep: true });
    expect(kept.status).toBe(200);
    expect((kept.body as AudioClip).keep).toBe(true);
  });

  it('refuses to record a clip that was not uploaded', async () => {
    const res = await save(randomUUID()).expect(400);
    expect(errorOf(res.body)).toBe('invalid_input');
  });

  it('refuses a recording time from before the SOS', async () => {
    const clipId = randomUUID();
    await upload(clipId);
    await save(clipId, { recordedAt: new Date(Date.now() - 3600_000).toISOString() }).expect(400);
  });

  it('refuses audio for a test SOS and for another user’s SOS', async () => {
    const testId = randomUUID();
    await ctx.db
      .insertInto('sos_events')
      .values({
        id: testId,
        user_id: userId,
        trigger: 'button',
        is_test: true,
        status: 'ended',
        started_at: new Date(),
      })
      .execute();
    const res = await api()
      .post(`/v1/sos/${testId}/audio-upload`)
      .set(bearer(token))
      .send({ clipId: randomUUID(), sizeBytes: 100 })
      .expect(409);
    expect(errorOf(res.body)).toBe('conflict');

    const other = await appUser(ctx, '+919800000099');
    await api()
      .post(`/v1/sos/${sosId}/audio-upload`)
      .set(bearer(other.token))
      .send({ clipId: randomUUID(), sizeBytes: 100 })
      .expect(404);
  });

  it('never lets another user play or keep a clip', async () => {
    const clipId = randomUUID();
    await upload(clipId);
    await save(clipId).expect(200);
    const other = await appUser(ctx, '+919800000099');
    await api().get(`/v1/audio/${clipId}/play`).set(bearer(other.token)).expect(404);
    await api()
      .patch(`/v1/audio/${clipId}`)
      .set(bearer(other.token))
      .send({ keep: true })
      .expect(404);
  });

  it('refuses a clip bigger than 2 MB before giving a link', async () => {
    const res = await api()
      .post(`/v1/sos/${sosId}/audio-upload`)
      .set(bearer(token))
      .send({ clipId: randomUUID(), sizeBytes: 2 * 1024 * 1024 + 1 })
      .expect(400);
    expect(errorOf(res.body)).toBe('invalid_input');
  });

  it('does not play a deleted clip', async () => {
    const clipId = randomUUID();
    await upload(clipId);
    await save(clipId).expect(200);
    await ctx.db.updateTable('media_clips').set({ deleted_at: new Date() }).execute();
    await api().get(`/v1/audio/${clipId}/play`).set(bearer(token)).expect(404);
  });
});
