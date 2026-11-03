import { randomUUID } from 'node:crypto';
import {
  appUser,
  bearer,
  http,
  resetAppTest,
  startAppTest,
  stopAppTest,
  type AppTestContext,
} from '../app-test-support';

// Plan step A5, test only (`pnpm test:load`, not part of `pnpm test`): 50 phones in an SOS, each
// sending 1 location point every 3 s, for 30 s. The server must stay fast and save every point once.
const PHONES = 50;
const EVERY_MS = 3_000;
const ROUNDS = 10;

let ctx: AppTestContext;

beforeAll(async () => {
  ctx = await startAppTest();
  await resetAppTest(ctx);
});

afterAll(async () => {
  await stopAppTest(ctx);
});

it(`${PHONES} phones × 1 point / ${EVERY_MS / 1000} s stays fast and saves every point once`, async () => {
  const phones: { token: string; sosId: string }[] = [];
  for (let i = 0; i < PHONES; i++) {
    // Real phones log in from different IPs; here all share one, so reset its login limit.
    const loginKeys = await ctx.redis.keys('ratelimit:app:login:*');
    if (loginKeys.length) await ctx.redis.del(...loginKeys);
    const { token } = await appUser(ctx, `+9198${String(10000000 + i).padStart(8, '0')}`);
    const sosId = randomUUID();
    await http(ctx)
      .post('/v1/sos')
      .set(bearer(token))
      .send({ id: sosId, trigger: 'button', startedAt: new Date().toISOString() })
      .expect(200);
    phones.push({ token, sosId });
  }

  const times: number[] = [];
  const send = async (p: { token: string; sosId: string }, round: number) => {
    const start = performance.now();
    await http(ctx)
      .post('/v1/locations')
      .set(bearer(p.token))
      .send({
        points: [
          {
            clientPointId: randomUUID(),
            sosId: p.sosId,
            lat: 28.6 + round * 0.0001,
            lng: 77.36,
            accuracyM: 10,
            batteryPct: 80,
            network: 'mobile',
            recordedAt: new Date().toISOString(),
          },
        ],
      })
      .expect(200);
    times.push(performance.now() - start);
  };

  for (let round = 0; round < ROUNDS; round++) {
    const started = Date.now();
    // Phones are not in step: spread each round over the 3 seconds.
    await Promise.all(
      phones.map(
        (p, i) =>
          new Promise<void>((resolve, reject) => {
            setTimeout(
              () => {
                send(p, round).then(resolve, reject);
              },
              (i * EVERY_MS) / PHONES,
            );
          }),
      ),
    );
    const wait = Math.max(0, EVERY_MS - (Date.now() - started));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, wait);
    });
  }

  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];
  const max = times.at(-1)!;
  console.log(
    `location calls: ${times.length}, p50 ${times[times.length >> 1].toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, max ${max.toFixed(0)} ms`,
  );
  expect(times).toHaveLength(PHONES * ROUNDS);
  expect(p95).toBeLessThan(300);
  expect(max).toBeLessThan(2_000);

  const saved = await ctx.db
    .selectFrom('location_points')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow();
  expect(Number(saved.n)).toBe(PHONES * ROUNDS);
}, 120_000);
