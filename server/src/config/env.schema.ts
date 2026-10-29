import { z } from 'zod';

const postgresUrl = z.url({
  protocol: /^postgres(ql)?$/,
  error: 'Required: a postgresql:// URL',
});
const redisUrl = z.url({ protocol: /^rediss?$/, error: 'Required: a redis:// URL' });
const httpUrl = z
  .url({ protocol: /^https?$/, error: 'Must be a http(s):// address' })
  .transform((url) => url.replace(/\/+$/, ''));
// S3 bucket names: 3–63 lowercase letters, digits, dots and dashes.
const bucketName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, { error: 'Must be a valid bucket name' });

/** Local file storage (SeaweedFS in docker-compose.yml). Used only outside production. */
const LOCAL_STORAGE = {
  S3_ENDPOINT: 'http://localhost:8333',
  S3_BUCKET: 'sarthi-dev',
  S3_BUCKET_TEST: 'sarthi-test',
  S3_ACCESS_KEY: 'sarthi_local',
  S3_SECRET_KEY: 'change_me_local_only',
} as const;

/** User-app settings with local defaults outside production (required in production). */
const LOCAL_APP = {
  // A fixed key is fine locally: it only protects hashes of test phone numbers.
  PHONE_HASH_KEY: Buffer.alloc(32, 1).toString('base64'),
  GUARDIAN_WEB_URL: 'http://localhost:5175',
} as const;

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: postgresUrl,
    REDIS_URL: redisUrl,
    // Required in development and test only (checked below); not used in production.
    DATABASE_URL_TEST: postgresUrl.optional(),
    REDIS_URL_TEST: redisUrl.optional(),
    // 32 random bytes in base64. Two separate keys are derived from it (see auth/auth-keys.ts).
    ADMIN_TOTP_ENCRYPTION_KEY: z
      .string({ error: 'Required: 32 random bytes in base64 (see README)' })
      .regex(/^[A-Za-z0-9+/]{43}=$/, { error: 'Must be 32 random bytes in base64 (see README)' }),
    // The admin panel's address: the only origin allowed by CORS and the Origin check.
    ADMIN_PANEL_ORIGIN: z
      .url({ protocol: /^https?$/, error: 'Must be a http(s):// address' })
      .default('http://localhost:5173')
      .transform((url) => new URL(url).origin),
    // 2-step login for admins. Default: off in development, on in test and production.
    // Never allowed off in production (staging also runs as production).
    ADMIN_TWO_STEP: z.enum(['on', 'off'], { error: 'Must be on or off' }).optional(),
    // File storage for photos and audio, through the S3 API: SeaweedFS locally, DigitalOcean
    // Spaces on servers. Required in production; local defaults (LOCAL_STORAGE) otherwise.
    S3_ENDPOINT: httpUrl.optional(),
    // The address phones use for upload links, if different from S3_ENDPOINT.
    S3_PUBLIC_ENDPOINT: httpUrl.optional(),
    S3_REGION: z.string().min(1).default('us-east-1'),
    S3_BUCKET: bucketName.optional(),
    // Separate bucket for automated tests (emptied after each run); not used in production.
    S3_BUCKET_TEST: bucketName.optional(),
    S3_ACCESS_KEY: z.string().min(1).optional(),
    S3_SECRET_KEY: z.string().min(1).optional(),
    // Firebase project for app login (phone OTP). Without it, app login is off outside production.
    FIREBASE_PROJECT_ID: z
      .string()
      .regex(/^[a-z0-9-]{4,40}$/, { error: 'Must be a Firebase project id (e.g. sarthi-rakshak)' })
      .optional(),
    // Path to the Firebase service-account key file; read by Firebase itself. Keep it outside the
    // project folder and never commit it.
    GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1).optional(),
    // 32 random bytes in base64: key for hashing phone numbers that declined a guardian invite.
    PHONE_HASH_KEY: z
      .string()
      .regex(/^[A-Za-z0-9+/]{43}=$/, { error: 'Must be 32 random bytes in base64 (see README)' })
      .optional(),
    // Where the guardian pages are served; used in invite and SOS links.
    GUARDIAN_WEB_URL: httpUrl.optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.ADMIN_TWO_STEP === 'off') {
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_TWO_STEP'],
        message:
          'Must be on when NODE_ENV is production. 2-step login is always required on staging and production.',
      });
    }
    if (env.NODE_ENV === 'production') {
      for (const key of [
        'S3_ENDPOINT',
        'S3_BUCKET',
        'S3_ACCESS_KEY',
        'S3_SECRET_KEY',
        'FIREBASE_PROJECT_ID',
        'PHONE_HASH_KEY',
        'GUARDIAN_WEB_URL',
      ] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'Required when NODE_ENV is production',
          });
        }
      }
      return;
    }

    for (const key of ['DATABASE_URL_TEST', 'REDIS_URL_TEST'] as const) {
      if (!env[key]) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `Required when NODE_ENV is ${env.NODE_ENV}`,
        });
      }
    }

    // Safety check: tests must never touch development data.
    if (env.NODE_ENV === 'test') {
      if (env.DATABASE_URL_TEST && sameUrl(env.DATABASE_URL_TEST, env.DATABASE_URL)) {
        ctx.addIssue({
          code: 'custom',
          path: ['DATABASE_URL_TEST'],
          message: 'Must be a different database from DATABASE_URL',
        });
      }
      if (env.REDIS_URL_TEST && sameRedisSlot(env.REDIS_URL_TEST, env.REDIS_URL)) {
        ctx.addIssue({
          code: 'custom',
          path: ['REDIS_URL_TEST'],
          message: 'Must use a different Redis slot from REDIS_URL',
        });
      }
      const bucket = env.S3_BUCKET ?? LOCAL_STORAGE.S3_BUCKET;
      if ((env.S3_BUCKET_TEST ?? LOCAL_STORAGE.S3_BUCKET_TEST) === bucket) {
        ctx.addIssue({
          code: 'custom',
          path: ['S3_BUCKET_TEST'],
          message: 'Must be a different bucket from S3_BUCKET',
        });
      }
    }
  })
  .transform((env) => {
    const local = env.NODE_ENV === 'production' ? undefined : LOCAL_STORAGE;
    return {
      ...env,
      ADMIN_TWO_STEP: env.ADMIN_TWO_STEP ?? (env.NODE_ENV === 'development' ? 'off' : 'on'),
      // In production these are guaranteed by the check above; elsewhere local defaults apply.
      S3_ENDPOINT: (env.S3_ENDPOINT ?? local?.S3_ENDPOINT)!,
      S3_BUCKET: (env.S3_BUCKET ?? local?.S3_BUCKET)!,
      S3_BUCKET_TEST: env.S3_BUCKET_TEST ?? local?.S3_BUCKET_TEST,
      S3_ACCESS_KEY: (env.S3_ACCESS_KEY ?? local?.S3_ACCESS_KEY)!,
      S3_SECRET_KEY: (env.S3_SECRET_KEY ?? local?.S3_SECRET_KEY)!,
      PHONE_HASH_KEY: (env.PHONE_HASH_KEY ?? (local && LOCAL_APP.PHONE_HASH_KEY))!,
      GUARDIAN_WEB_URL: (env.GUARDIAN_WEB_URL ?? (local && LOCAL_APP.GUARDIAN_WEB_URL))!,
    };
  });

export type Env = z.infer<typeof envSchema>;

/** Checks the settings and returns them typed. Throws one readable error listing every problem. */
export function validateEnv(raw: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(raw);
  if (result.success) return result.data;

  const lines = result.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
  throw new Error(
    [
      'Invalid server settings:',
      ...lines,
      'Set them in .env (see .env.example) or as environment variables.',
    ].join('\n'),
  );
}

/** The database and Redis the server should connect to: the test ones when NODE_ENV is test. */
export function activeConnections(env: Env): { databaseUrl: string; redisUrl: string } {
  if (env.NODE_ENV === 'test') {
    // validateEnv guarantees both are set in test mode.
    return { databaseUrl: env.DATABASE_URL_TEST!, redisUrl: env.REDIS_URL_TEST! };
  }
  return { databaseUrl: env.DATABASE_URL, redisUrl: env.REDIS_URL };
}

export interface StorageSettings {
  endpoint: string;
  /** Address put into upload links for phones. */
  publicEndpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** The file storage bucket the server should use: the test one when NODE_ENV is test. */
export function activeStorage(env: Env): StorageSettings {
  return {
    endpoint: env.S3_ENDPOINT,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT,
    region: env.S3_REGION,
    // validateEnv guarantees a separate test bucket in test mode.
    bucket: env.NODE_ENV === 'test' ? env.S3_BUCKET_TEST! : env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  };
}

function sameUrl(a: string, b: string): boolean {
  return new URL(a).href === new URL(b).href;
}

/** redis://host:6379 and redis://host:6379/0 are the same slot. */
function sameRedisSlot(a: string, b: string): boolean {
  const slot = (url: URL) => `${url.host}/${url.pathname.slice(1) || '0'}`;
  return slot(new URL(a)) === slot(new URL(b));
}
