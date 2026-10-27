import { z } from 'zod';

const postgresUrl = z.url({
  protocol: /^postgres(ql)?$/,
  error: 'Required: a postgresql:// URL',
});
const redisUrl = z.url({ protocol: /^rediss?$/, error: 'Required: a redis:// URL' });

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
    if (env.NODE_ENV === 'production') return;

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
    }
  })
  .transform((env) => ({
    ...env,
    ADMIN_TWO_STEP: env.ADMIN_TWO_STEP ?? (env.NODE_ENV === 'development' ? 'off' : 'on'),
  }));

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

function sameUrl(a: string, b: string): boolean {
  return new URL(a).href === new URL(b).href;
}

/** redis://host:6379 and redis://host:6379/0 are the same slot. */
function sameRedisSlot(a: string, b: string): boolean {
  const slot = (url: URL) => `${url.host}/${url.pathname.slice(1) || '0'}`;
  return slot(new URL(a)) === slot(new URL(b));
}
