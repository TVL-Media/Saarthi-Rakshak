import { validateEnv } from '../../config/env.schema';
import { FakePhoneTokenVerifier, FirebasePhoneTokenVerifier } from './phone-token-verifier';

const env = validateEnv({
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://sarthi:pw@localhost:5433/sarthi_dev',
  DATABASE_URL_TEST: 'postgresql://sarthi:pw@localhost:5433/sarthi_test',
  REDIS_URL: 'redis://localhost:6379/0',
  REDIS_URL_TEST: 'redis://localhost:6379/1',
  ADMIN_TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
});

describe('FirebasePhoneTokenVerifier', () => {
  it('turns login off (service_unavailable) when FIREBASE_PROJECT_ID is not set', async () => {
    const verifier = new FirebasePhoneTokenVerifier(env);
    await expect(verifier.verify('anything')).rejects.toMatchObject({
      response: { error: 'service_unavailable' },
      status: 503,
    });
  });
});

describe('FakePhoneTokenVerifier (tests only)', () => {
  it('accepts "test-phone:<number>" and nothing else', async () => {
    const fake = new FakePhoneTokenVerifier();
    await expect(fake.verify(FakePhoneTokenVerifier.token('+919812344521'))).resolves.toBe(
      '+919812344521',
    );
    await expect(fake.verify('eyJhbGciOi...')).rejects.toMatchObject({ status: 401 });
  });
});
