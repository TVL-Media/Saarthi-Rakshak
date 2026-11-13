import { activeConnections, activeStorage, validateEnv } from './env.schema';

const validDev = {
  NODE_ENV: 'development',
  PORT: '3000',
  DATABASE_URL: 'postgresql://sarthi:pw@localhost:5433/sarthi_dev',
  DATABASE_URL_TEST: 'postgresql://sarthi:pw@localhost:5433/sarthi_test',
  REDIS_URL: 'redis://localhost:6379/0',
  REDIS_URL_TEST: 'redis://localhost:6379/1',
  ADMIN_TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

/** File storage settings that production must set (local defaults apply elsewhere). */
const productionStorage = {
  S3_ENDPOINT: 'https://blr1.digitaloceanspaces.com',
  S3_BUCKET: 'sarthi-prod',
  S3_ACCESS_KEY: 'key',
  S3_SECRET_KEY: 'secret',
  FIREBASE_PROJECT_ID: 'sarthi-rakshak',
  PHONE_HASH_KEY: Buffer.alloc(32, 9).toString('base64'),
  GUARDIAN_WEB_URL: 'https://g.example.in',
  GUARDIAN_LINK_KEY: Buffer.alloc(32, 8).toString('base64'),
  SMS_WEBHOOK_SECRET: 'a-long-random-shared-secret-123',
};

describe('validateEnv', () => {
  describe('ADMIN_TOTP_ENCRYPTION_KEY', () => {
    it('is required', () => {
      expect(() => validateEnv({ ...validDev, ADMIN_TOTP_ENCRYPTION_KEY: undefined })).toThrow(
        /ADMIN_TOTP_ENCRYPTION_KEY: Required/,
      );
    });

    it.each(['generate_me', Buffer.alloc(16).toString('base64')])(
      'refuses a placeholder or a key that is not 32 bytes (%p)',
      (key) => {
        expect(() => validateEnv({ ...validDev, ADMIN_TOTP_ENCRYPTION_KEY: key })).toThrow(
          /ADMIN_TOTP_ENCRYPTION_KEY: Must be 32 random bytes/,
        );
      },
    );
  });

  describe('ADMIN_TWO_STEP', () => {
    const production = { ...validDev, ...productionStorage, NODE_ENV: 'production' };

    it.each([
      ['development', 'off'],
      ['test', 'on'],
      ['production', 'on'],
    ])('defaults to the right value when NODE_ENV is %s (%s)', (NODE_ENV, expected) => {
      expect(validateEnv({ ...validDev, ...productionStorage, NODE_ENV }).ADMIN_TWO_STEP).toBe(
        expected,
      );
    });

    it('can be turned on in development and off in test', () => {
      expect(validateEnv({ ...validDev, ADMIN_TWO_STEP: 'on' }).ADMIN_TWO_STEP).toBe('on');
      expect(
        validateEnv({ ...validDev, NODE_ENV: 'test', ADMIN_TWO_STEP: 'off' }).ADMIN_TWO_STEP,
      ).toBe('off');
    });

    it('refuses the temporary admin password in production', () => {
      expect(() =>
        validateEnv({ ...production, ADMIN_TEMP_PASSWORD: 'temporary-river-77' }),
      ).toThrow(/ADMIN_TEMP_PASSWORD: The temporary admin password is for test servers only/);
    });

    it('refuses the development test login in production', () => {
      expect(() => validateEnv({ ...production, DEV_LOGIN_CODE: '123456' })).toThrow(
        /DEV_LOGIN_CODE: The test login is for development only/,
      );
    });

    it('refuses off in production (staging also runs as production), with a clear message', () => {
      expect(() => validateEnv({ ...production, ADMIN_TWO_STEP: 'off' })).toThrow(
        /ADMIN_TWO_STEP: Must be on when NODE_ENV is production\. 2-step login is always required on staging and production\./,
      );
      expect(validateEnv({ ...production, ADMIN_TWO_STEP: 'on' }).ADMIN_TWO_STEP).toBe('on');
    });

    it('refuses anything other than on or off', () => {
      expect(() => validateEnv({ ...validDev, ADMIN_TWO_STEP: 'false' })).toThrow(
        /ADMIN_TWO_STEP: Must be on or off/,
      );
    });
  });

  describe('ADMIN_PANEL_ORIGIN', () => {
    it('defaults to the local Vite address', () => {
      expect(validateEnv(validDev).ADMIN_PANEL_ORIGIN).toBe('http://localhost:5173');
    });

    it('is reduced to a bare origin (no path or trailing slash)', () => {
      const env = validateEnv({ ...validDev, ADMIN_PANEL_ORIGIN: 'https://admin.example.in/' });
      expect(env.ADMIN_PANEL_ORIGIN).toBe('https://admin.example.in');
    });
  });

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
      expect(() =>
        validateEnv({ ...withoutTestUrls, ...productionStorage, NODE_ENV: 'production' }),
      ).not.toThrow();
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

describe('file storage (S3_*)', () => {
  it('uses the local SeaweedFS defaults outside production', () => {
    const env = validateEnv(validDev);
    expect(activeStorage(env)).toEqual({
      endpoint: 'http://localhost:8333',
      publicEndpoint: 'http://localhost:8333',
      region: 'us-east-1',
      bucket: 'sarthi-dev',
      accessKeyId: 'sarthi_local',
      secretAccessKey: 'change_me_local_only',
    });
  });

  it('uses only the test bucket in test mode', () => {
    expect(activeStorage(validateEnv({ ...validDev, NODE_ENV: 'test' })).bucket).toBe(
      'sarthi-test',
    );
  });

  it('refuses a test bucket that is the development bucket', () => {
    expect(() =>
      validateEnv({ ...validDev, NODE_ENV: 'test', S3_BUCKET: 'same', S3_BUCKET_TEST: 'same' }),
    ).toThrow(/S3_BUCKET_TEST: Must be a different bucket/);
  });

  it('requires every storage setting in production', () => {
    expect(() => validateEnv({ ...validDev, NODE_ENV: 'production' })).toThrow(
      /S3_ENDPOINT: Required[\s\S]*S3_BUCKET: Required[\s\S]*S3_ACCESS_KEY: Required[\s\S]*S3_SECRET_KEY: Required/,
    );
  });

  it('uses S3_PUBLIC_ENDPOINT for upload links when set, without a trailing slash', () => {
    const env = validateEnv({ ...validDev, S3_PUBLIC_ENDPOINT: 'http://192.168.1.20:8333/' });
    expect(activeStorage(env).publicEndpoint).toBe('http://192.168.1.20:8333');
  });

  it('rejects an invalid bucket name', () => {
    expect(() => validateEnv({ ...validDev, S3_BUCKET: 'Bad_Name' })).toThrow(
      /S3_BUCKET: Must be a valid bucket name/,
    );
  });
});

describe('FIREBASE_PROJECT_ID', () => {
  it('is optional outside production (app login is then off)', () => {
    expect(validateEnv(validDev).FIREBASE_PROJECT_ID).toBeUndefined();
  });

  it('is required in production', () => {
    const withoutFirebase = { ...productionStorage, FIREBASE_PROJECT_ID: undefined };
    expect(() => validateEnv({ ...validDev, ...withoutFirebase, NODE_ENV: 'production' })).toThrow(
      /FIREBASE_PROJECT_ID: Required when NODE_ENV is production/,
    );
  });

  it('refuses something that is not a project id', () => {
    expect(() => validateEnv({ ...validDev, FIREBASE_PROJECT_ID: 'My Project!' })).toThrow(
      /FIREBASE_PROJECT_ID: Must be a Firebase project id/,
    );
  });
});

describe('PHONE_HASH_KEY and GUARDIAN_WEB_URL', () => {
  it('have local defaults outside production', () => {
    const env = validateEnv(validDev);
    expect(env.PHONE_HASH_KEY).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(env.GUARDIAN_WEB_URL).toBe('http://localhost:5175');
  });

  it('are required in production', () => {
    const settings = {
      ...productionStorage,
      PHONE_HASH_KEY: undefined,
      GUARDIAN_WEB_URL: undefined,
    };
    expect(() => validateEnv({ ...validDev, ...settings, NODE_ENV: 'production' })).toThrow(
      /PHONE_HASH_KEY: Required[\s\S]*GUARDIAN_WEB_URL: Required/,
    );
  });

  it('refuses a hash key that is not 32 bytes', () => {
    expect(() => validateEnv({ ...validDev, PHONE_HASH_KEY: 'short' })).toThrow(/PHONE_HASH_KEY/);
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
