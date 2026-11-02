import type { LoginReply } from '@sarthi/shared';
import {
  http,
  resetAppTest,
  startAppTest,
  stopAppTest,
  type AppTestContext,
} from './app-test-support';

const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

describe('POST /v1/auth/dev-login (development only)', () => {
  let ctx: AppTestContext;

  afterEach(async () => {
    await stopAppTest(ctx);
    delete process.env.DEV_LOGIN_PHONE;
    delete process.env.DEV_LOGIN_CODE;
    delete process.env.DEV_LOGIN_UNTIL;
  });

  async function start(until = tomorrow) {
    process.env.DEV_LOGIN_PHONE = '9999900001';
    process.env.DEV_LOGIN_CODE = '482913';
    process.env.DEV_LOGIN_UNTIL = until;
    ctx = await startAppTest();
    await resetAppTest(ctx);
  }

  it('logs in the test number with the test code', async () => {
    await start();
    const res = await http(ctx)
      .post('/v1/auth/dev-login')
      .send({ phone: '99999 00001', code: '482913' })
      .expect(200);
    const reply = res.body as LoginReply;
    expect(reply.user.phone).toBe('+919999900001');
    expect(reply.isNewUser).toBe(true);
    await http(ctx).get('/v1/me').set('Authorization', `Bearer ${reply.token}`).expect(200);
  });

  it('refuses another number or a wrong code', async () => {
    await start();
    await http(ctx)
      .post('/v1/auth/dev-login')
      .send({ phone: '9999900002', code: '482913' })
      .expect(400);
    await http(ctx)
      .post('/v1/auth/dev-login')
      .send({ phone: '9999900001', code: '000000' })
      .expect(400);
  });

  it('is off after the end date', async () => {
    await start('2026-01-01');
    await http(ctx)
      .post('/v1/auth/dev-login')
      .send({ phone: '9999900001', code: '482913' })
      .expect(404);
  });

  it('is off when not set up', async () => {
    ctx = await startAppTest();
    await http(ctx)
      .post('/v1/auth/dev-login')
      .send({ phone: '9999900001', code: '482913' })
      .expect(404);
  });
});
