import { activeConnections, validateEnv } from './env.schema';

const validDev = {
  NODE_ENV: 'development',
  PORT: '3000',
  DATABASE_URL: 'postgresql://sarthi:pw@localhost:5433/sarthi_dev',
  DATABASE_URL_TEST: 'postgresql://sarthi:pw@localhost:5433/sarthi_test',
  REDIS_URL: 'redis://localhost:6379/0',
  REDIS_URL_TEST: 'redis://localhost:6379/1',
};

describe('validateEnv', () => {
  it('accepts valid development settings', () => {
    const env = validateEnv(validDev);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('defaults NODE_ENV to development and PORT to 3000', () => {
    const env = validateEnv({ ...validDev, NODE_ENV: undefined, PORT: undefined });
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
  });

  it('gives a clear error when DATABASE_URL is missing', () => {
    expect(() => validateEnv({ ...validDev, DATABASE_URL: undefined })).toThrow(
      /DATABASE_URL: Required/,
    );
  });

  it('lists every problem at once', () => {
    expect(() => validateEnv({ ...validDev, DATABASE_URL: undefined, REDIS_URL: 'nope' })).toThrow(
      /DATABASE_URL[\s\S]*REDIS_URL/,
    );
  });

  it('rejects a non-PostgreSQL database URL', () => {
    expect(() => validateEnv({ ...validDev, DATABASE_URL: 'mysql://localhost/x' })).toThrow(
      /DATABASE_URL/,
    );
  });

  describe('test settings (DATABASE_URL_TEST, REDIS_URL_TEST)', () => {
    const withoutTestUrls = {
      ...validDev,
      DATABASE_URL_TEST: undefined,
      REDIS_URL_TEST: undefined,
    };

    it.each(['development', 'test'])('are required when NODE_ENV is %s', (NODE_ENV) => {
      expect(() => validateEnv({ ...withoutTestUrls, NODE_ENV })).toThrow(
        /DATABASE_URL_TEST: Required[\s\S]*REDIS_URL_TEST: Required/,
      );
    });

    it('are not required when NODE_ENV is production', () => {
      expect(() => validateEnv({ ...withoutTestUrls, NODE_ENV: 'production' })).not.toThrow();
    });
  });

  describe('in test mode, refuses to share development data', () => {
    it('rejects a test database that is the development database', () => {
      expect(() =>
        validateEnv({ ...validDev, NODE_ENV: 'test', DATABASE_URL_TEST: validDev.DATABASE_URL }),
      ).toThrow(/DATABASE_URL_TEST: Must be a different database/);
    });

    it('rejects a test Redis slot that is the development slot (including the default /0)', () => {
      expect(() =>
        validateEnv({ ...validDev, NODE_ENV: 'test', REDIS_URL_TEST: 'redis://localhost:6379' }),
      ).toThrow(/REDIS_URL_TEST: Must use a different Redis slot/);
    });
  });
});

describe('activeConnections', () => {
  it('uses the development database and Redis outside test mode', () => {
    expect(activeConnections(validateEnv(validDev))).toEqual({
      databaseUrl: validDev.DATABASE_URL,
      redisUrl: validDev.REDIS_URL,
    });
  });

  it('uses only the test database and Redis slot in test mode', () => {
    expect(activeConnections(validateEnv({ ...validDev, NODE_ENV: 'test' }))).toEqual({
      databaseUrl: validDev.DATABASE_URL_TEST,
      redisUrl: validDev.REDIS_URL_TEST,
    });
  });
});
