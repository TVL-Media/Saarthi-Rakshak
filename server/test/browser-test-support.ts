// Helpers for the admin panel's Playwright tests (apps/admin/e2e). Test database and test
// Redis slot only: openTestDatabase refuses any database whose name does not end in _test.
import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import { deriveAuthKeys } from '../src/auth/auth-keys';
import { base32Decode, base32Encode } from '../src/auth/base32';
import { encrypt } from '../src/auth/crypto-box';
import { hashPassword } from '../src/auth/password';
import { timeStep, totpCode } from '../src/auth/totp';
import { activeConnections, validateEnv } from '../src/config/env.schema';
import { createFirstSuperAdmin, insertDefaultSettings } from '../src/setup/setup';
import { openTestDatabase, resetTestDatabase, wipeTestDatabase } from './test-database';

async function withTestDatabase<T>(
  fn: (db: Awaited<ReturnType<typeof openTestDatabase>>) => Promise<T>,
): Promise<T> {
  const db = await openTestDatabase();
  try {
    return await fn(db);
  } finally {
    await db.destroy();
  }
}

/** Clean test database and an empty test Redis slot (rate limits, audit de-duplication). */
export async function resetForBrowserTests(): Promise<void> {
  await withTestDatabase(resetTestDatabase);
  const redis = new Redis(activeConnections(validateEnv(process.env)).redisUrl);
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}

export async function wipeAfterBrowserTests(): Promise<void> {
  await withTestDatabase(wipeTestDatabase);
}

/** The first Super Admin, made by the real setup code. Returns the one-time password. */
export async function createFirstSuperAdminForTest(name: string, email: string): Promise<string> {
  const issued = await withTestDatabase((db) => createFirstSuperAdmin(db, { name, email }));
  return issued.temporaryPassword;
}

/** An admin (Support Admin by default) with a known password and 2-step already set up. */
export async function createSupportAdminForTest(
  name: string,
  email: string,
  role: 'support_admin' | 'super_admin' = 'support_admin',
): Promise<{ password: string; secret: string }> {
  const password = 'support-' + randomBytes(6).toString('hex');
  const secret = randomBytes(20);
  const keys = deriveAuthKeys(validateEnv(process.env).ADMIN_TOTP_ENCRYPTION_KEY);
  await withTestDatabase(async (db) => {
    const row = await db
      .insertInto('admins')
      .values({
        name,
        email,
        role,
        password_hash: await hashPassword(password),
        totp_enabled_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .updateTable('admins')
      .set({ totp_secret_encrypted: encrypt(keys.totpSecretKey, secret, row.id) })
      .where('id', '=', row.id)
      .execute();
  });
  return { password, secret: base32Encode(secret) };
}

/** An admin with a known password and no 2-step setup (for the 2-step-off server). */
export async function createAdminForTest(
  role: 'super_admin' | 'support_admin',
  name: string,
  email: string,
): Promise<string> {
  const password = 'admin-' + randomBytes(6).toString('hex');
  await withTestDatabase(async (db) => {
    await db
      .insertInto('admins')
      .values({ name, email, role, password_hash: await hashPassword(password) })
      .execute();
  });
  return password;
}

/** The default safety settings, saved by the real setup code. */
export async function insertDefaultSettingsForTest(): Promise<void> {
  await withTestDatabase((db) => insertDefaultSettings(db));
}

export async function settingValueForTest(key: string): Promise<unknown> {
  return withTestDatabase(async (db) => {
    const row = await db
      .selectFrom('settings')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst();
    return row?.value;
  });
}

/** The settings.changed audit rows: setting, reason and before/after values. */
export async function settingChangesForTest(): Promise<
  { target_id: string | null; reason: string | null; details: unknown }[]
> {
  return withTestDatabase((db) =>
    db
      .selectFrom('audit_log')
      .select(['target_id', 'reason', 'details'])
      .where('action', '=', 'settings.changed')
      .orderBy('id')
      .execute(),
  );
}

/** An admin's row (for checks in browser tests). */
export async function adminForTest(email: string) {
  return withTestDatabase((db) =>
    db.selectFrom('admins').selectAll().where('email', '=', email).executeTakeFirst(),
  );
}

/** Every audit row as text, to check what was (and was not) logged. */
export async function auditLogTextForTest(): Promise<string> {
  return withTestDatabase(async (db) =>
    JSON.stringify(await db.selectFrom('audit_log').selectAll().execute()),
  );
}

/**
 * Ends an admin's open sessions on the server, keeping the browser's cookie: 'idle' makes them
 * look 31 minutes inactive; 'ended' ends them as a password change elsewhere would.
 */
export async function endSessionsForTest(email: string, how: 'idle' | 'ended'): Promise<void> {
  await withTestDatabase(async (db) => {
    const admin = await db
      .selectFrom('admins')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirstOrThrow();
    const open = db
      .updateTable('admin_sessions')
      .where('admin_id', '=', admin.id)
      .where('ended_at', 'is', null);
    if (how === 'idle') {
      await open.set({ last_seen_at: new Date(Date.now() - 31 * 60_000) }).execute();
    } else {
      await open.set({ ended_at: new Date(), end_reason: 'password changed' }).execute();
    }
  });
}

/**
 * The authenticator code for a base32 key. `stepsAhead` 1 gives the next step's code (still
 * accepted), for a second login inside the same 30 seconds.
 */
export function authenticatorCode(base32Secret: string, stepsAhead = 0): string {
  return totpCode(base32Decode(base32Secret), timeStep(Date.now()) + stepsAhead);
}
