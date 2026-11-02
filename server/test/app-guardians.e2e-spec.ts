import { randomUUID } from 'node:crypto';
import type { Guardian } from '@sarthi/shared';
import { INVITES_PER_DAY } from '../src/app/guardians/guardians.service';
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
  messages.sent.length = 0;
  ({ token, userId } = await appUser(ctx));
  await http(ctx).patch('/v1/me').set(bearer(token)).send({ name: 'Priya Sharma' });
});

afterAll(() => stopAppTest(ctx));

const api = () => http(ctx);
const phoneOf = (i: number) => `98000 0000${i}`;

function add(name: string, phone: string, relation?: string) {
  return api().post('/v1/guardians').set(bearer(token)).send({ name, phone, relation });
}

/** The invite code from the last SMS (local log provider). */
function lastInviteCode(): string {
  const text = messages.sent.at(-1)!.text;
  return /\/i\/([A-Za-z0-9_-]+)/.exec(text)![1];
}

const errorOf = (body: unknown) => (body as { error: string }).error;

describe('Adding guardians', () => {
  it('adds a guardian, masks the number and sends an invite with a link', async () => {
    const res = await add('Ravi', '98123 00001', 'brother').expect(201);
    expect(res.body).toEqual({
      id: expect.any(String) as unknown,
      name: 'Ravi',
      relation: 'brother',
      phoneMasked: '+91 98•• ••0001',
      status: 'pending',
    });
    expect(messages.sent).toHaveLength(1);
    expect(messages.sent[0]).toMatchObject({
      guardianId: (res.body as Guardian).id,
      kind: 'invite',
    });
    expect(messages.sent[0].text).toContain('Priya Sharma added you as a guardian');
    expect(messages.sent[0].text).toMatch(/http:\/\/localhost:5175\/i\/[A-Za-z0-9_-]{30,}/);

    const row = await ctx.db.selectFrom('guardians').selectAll().executeTakeFirstOrThrow();
    expect(row.phone).toBe('+919812300001');
    expect(row.invite_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.invite_expires_at!.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);
  });

  it('lists guardians in the order they were added', async () => {
    await add('A', phoneOf(1)).expect(201);
    await add('B', phoneOf(2)).expect(201);
    const res = await api().get('/v1/guardians').set(bearer(token)).expect(200);
    expect((res.body as Guardian[]).map((g) => g.name)).toEqual(['A', 'B']);
  });

  it('allows up to 5 guardians', async () => {
    for (let i = 1; i <= 5; i++) await add(`G${i}`, phoneOf(i)).expect(201);
    const res = await add('G6', phoneOf(6)).expect(409);
    expect(errorOf(res.body)).toBe('limit_reached');
  });

  it('uses the max guardians setting from the admin panel', async () => {
    await ctx.db
      .insertInto('settings')
      .values({ key: 'guardian.max_count', value: JSON.stringify(2) })
      .execute();
    await add('A', phoneOf(1)).expect(201);
    await add('B', phoneOf(2)).expect(201);
    await add('C', phoneOf(3)).expect(409);
  });

  it("refuses the same number twice and the user's own number", async () => {
    await add('Ravi', phoneOf(1)).expect(201);
    expect(errorOf((await add('Ravi again', `+91 ${phoneOf(1)}`).expect(409)).body)).toBe(
      'conflict',
    );
    expect(errorOf((await add('Me', '9812344521').expect(400)).body)).toBe('invalid_input');
  });

  it('refuses a number that is not an Indian mobile', async () => {
    const res = await add('X', '12345 67890').expect(400);
    expect((res.body as { message: string }).message).toContain('phone');
  });

  it(`sends at most ${INVITES_PER_DAY} invites a day (resends count)`, async () => {
    const res = await add('Ravi', phoneOf(1)).expect(201);
    const id = (res.body as Guardian).id;
    for (let i = 1; i < INVITES_PER_DAY; i++) {
      await api().post(`/v1/guardians/${id}/resend-invite`).set(bearer(token)).expect(204);
    }
    await api().post(`/v1/guardians/${id}/resend-invite`).set(bearer(token)).expect(429);
    // A refused add leaves nothing behind.
    await add('Sita', phoneOf(2)).expect(429);
    expect(await ctx.db.selectFrom('guardians').select('id').execute()).toHaveLength(1);
  });
});

describe('Resend and remove', () => {
  it('resend makes a new link; the old one stops working', async () => {
    const res = await add('Ravi', phoneOf(1)).expect(201);
    const oldCode = lastInviteCode();
    await api()
      .post(`/v1/guardians/${(res.body as Guardian).id}/resend-invite`)
      .set(bearer(token))
      .expect(204);
    const newCode = lastInviteCode();
    expect(newCode).not.toBe(oldCode);
    await api().get(`/g/i/${oldCode}`).expect(404);
    await api().get(`/g/i/${newCode}`).expect(200);
  });

  it('resend is only for guardians who have not answered', async () => {
    const res = await add('Ravi', phoneOf(1)).expect(201);
    await api().post(`/g/i/${lastInviteCode()}/accept`).expect(204);
    await api()
      .post(`/v1/guardians/${(res.body as Guardian).id}/resend-invite`)
      .set(bearer(token))
      .expect(409);
  });

  it('removes a guardian', async () => {
    const res = await add('Ravi', phoneOf(1)).expect(201);
    await api()
      .delete(`/v1/guardians/${(res.body as Guardian).id}`)
      .set(bearer(token))
      .expect(204);
    const list = await api().get('/v1/guardians').set(bearer(token)).expect(200);
    expect(list.body).toEqual([]);
  });

  it("can't remove a guardian during an SOS", async () => {
    const res = await add('Ravi', phoneOf(1)).expect(201);
    await ctx.db
      .insertInto('sos_events')
      .values({ id: randomUUID(), user_id: userId, trigger: 'button', started_at: new Date() })
      .execute();
    const del = await api()
      .delete(`/v1/guardians/${(res.body as Guardian).id}`)
      .set(bearer(token))
      .expect(409);
    expect(errorOf(del.body)).toBe('conflict');
  });

  it("can't touch another user's guardian", async () => {
    const res = await add('Ravi', phoneOf(1)).expect(201);
    const other = await appUser(ctx, '+919812399999');
    const id = (res.body as Guardian).id;
    await api().delete(`/v1/guardians/${id}`).set(bearer(other.token)).expect(404);
    await api().post(`/v1/guardians/${id}/resend-invite`).set(bearer(other.token)).expect(404);
    await api().delete('/v1/guardians/not-a-uuid').set(bearer(token)).expect(404);
  });
});

describe('Invite link (guardian side, no login)', () => {
  beforeEach(async () => {
    await add('Ravi', phoneOf(1)).expect(201);
  });

  it('shows who invited them', async () => {
    const res = await api().get(`/g/i/${lastInviteCode()}`).expect(200);
    expect(res.body).toEqual({
      inviterFirstName: 'Priya',
      guardianName: 'Ravi',
      status: 'pending',
      expiresAt: expect.any(String) as unknown,
    });
    expect(JSON.stringify(res.body)).not.toContain('98');
  });

  it('accept: status becomes accepted (twice is fine)', async () => {
    const code = lastInviteCode();
    await api().post(`/g/i/${code}/accept`).expect(204);
    await api().post(`/g/i/${code}/accept`).expect(204);
    const list = await api().get('/v1/guardians').set(bearer(token)).expect(200);
    expect((list.body as Guardian[])[0].status).toBe('accepted');
    const { n } = await ctx.db
      .selectFrom('guardians')
      .select((eb) => eb.fn.count<string>('responded_at').as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(n)).toBe(1);
  });

  it('decline: the number is deleted, only a hash is kept, and it cannot be invited again', async () => {
    const code = lastInviteCode();
    await api().post(`/g/i/${code}/decline`).expect(204);

    const row = await ctx.db.selectFrom('guardians').selectAll().executeTakeFirstOrThrow();
    expect(row.invite_status).toBe('declined');
    expect(row.phone).toBeNull();
    const hashes = await ctx.db.selectFrom('guardian_invite_blocklist').selectAll().execute();
    expect(hashes).toHaveLength(1);
    expect(hashes[0].phone_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(hashes)).not.toContain('9800000001');

    const again = await add('Ravi', phoneOf(1)).expect(400);
    expect((again.body as { message: string }).message).toContain("can't be invited");
    // Another user can still invite that number.
    const other = await appUser(ctx, '+919812399999');
    await api()
      .post('/v1/guardians')
      .set(bearer(other.token))
      .send({ name: 'Ravi', phone: phoneOf(1) })
      .expect(201);
  });

  it('a declined guardian no longer counts towards the 5', async () => {
    await api().post(`/g/i/${lastInviteCode()}/decline`).expect(204);
    for (let i = 2; i <= 6; i++) await add(`G${i}`, phoneOf(i)).expect(201);
  });

  it('an accepted guardian can still decline with the link', async () => {
    const code = lastInviteCode();
    await api().post(`/g/i/${code}/accept`).expect(204);
    await api().post(`/g/i/${code}/decline`).expect(204);
    await api().post(`/g/i/${code}/accept`).expect(409);
  });

  it('an expired link answers link_expired', async () => {
    const code = lastInviteCode();
    await ctx.db
      .updateTable('guardians')
      .set({ invite_expires_at: new Date(Date.now() - 1000) })
      .execute();
    const res = await api().get(`/g/i/${code}`).expect(410);
    expect(errorOf(res.body)).toBe('link_expired');
    await api().post(`/g/i/${code}/accept`).expect(410);
  });

  it('a wrong code answers not_found', async () => {
    await api()
      .get(`/g/i/${'x'.repeat(32)}`)
      .expect(404);
    await api().get('/g/i/short').expect(404);
  });
});
