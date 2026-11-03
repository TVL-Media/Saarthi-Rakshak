// Helpers for the admin panel's Playwright tests (apps/admin/e2e). Test database and test
// Redis slot only: openTestDatabase refuses any database whose name does not end in _test.
import { randomBytes, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { sql } from 'kysely';
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

/**
 * A temporary app user (test database only) with a device and one guardian. "complete" means
 * every permission, battery saving off and an accepted guardian.
 */
export async function createUserForTest(
  phone: string,
  opts: { name?: string; complete?: boolean; runningJourney?: boolean } = {},
): Promise<string> {
  return withTestDatabase(async (db) => {
    const user = await db
      .insertInto('users')
      .values({ phone, name: opts.name ?? 'Test User' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('devices')
      .values({
        user_id: user.id,
        model: 'Redmi Note 12',
        android_version: '14',
        app_version: '1.0.0',
        permissions: opts.complete
          ? { location: true, notifications: true, sms: true, microphone: true }
          : { location: true },
        battery_optimisation_off: Boolean(opts.complete),
        last_seen_at: new Date(),
      })
      .execute();
    await db
      .insertInto('guardians')
      .values({
        user_id: user.id,
        name: 'Maa',
        phone: '+919800000001',
        invite_status: opts.complete ? 'accepted' : 'pending',
      })
      .execute();
    if (opts.runningJourney) await db.insertInto('journeys').values({ user_id: user.id }).execute();
    return user.id;
  });
}

/**
 * SOS and journey records for the History screen (test database only): a real SOS with alerts,
 * an opened link and a location gap; a TEST SOS; a journey that turned into an SOS; a journey
 * with lost contact; an SOS from a user who deleted their data.
 */
export async function createHistoryForTest(): Promise<{
  userId: string;
  realSos: string;
  journeyToSos: string;
}> {
  const at = (minutes: number) => new Date(Date.UTC(2025, 2, 14, 18, 0) + minutes * 60_000);
  return withTestDatabase(async (db) => {
    const userId = await (async () => {
      const u = await db
        .insertInto('users')
        .values({ phone: '+919812344521', name: 'Priya' })
        .returning('id')
        .executeTakeFirstOrThrow();
      return u.id;
    })();
    const g1 = (
      await db
        .insertInto('guardians')
        .values({
          user_id: userId,
          name: 'Rohan',
          phone: '+919800000001',
          relation: 'brother',
          invite_status: 'accepted',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const realSos = randomUUID();
    await db
      .insertInto('sos_events')
      .values({
        id: realSos,
        user_id: userId,
        trigger: 'button',
        started_at: at(0),
        status: 'ended',
        ended_at: at(20),
      })
      .execute();
    await db
      .insertInto('alerts')
      .values({
        sos_event_id: realSos,
        guardian_id: g1,
        channel: 'sms',
        type: 'sos',
        status: 'delivered',
        sent_at: at(0.1),
        delivered_at: at(0.2),
      })
      .execute();
    await db
      .insertInto('guardian_links')
      .values({
        sos_event_id: realSos,
        guardian_id: g1,
        token_hash: randomUUID(),
        expires_at: at(60),
        opened_at: at(1),
        responding_at: at(2),
      })
      .execute();
    const point = sql<string>`ST_MakePoint(77.3, 28.5)::geography`;
    await db
      .insertInto('location_points')
      .values([
        { user_id: userId, sos_event_id: realSos, location: point, recorded_at: at(3) },
        { user_id: userId, sos_event_id: realSos, location: point, recorded_at: at(8) },
      ])
      .execute();

    await db
      .insertInto('sos_events')
      .values({
        id: randomUUID(),
        user_id: userId,
        trigger: 'widget',
        started_at: at(30),
        status: 'ended',
        ended_at: at(31),
        is_test: true,
      })
      .execute();
    const journeyToSos = (
      await db
        .insertInto('journeys')
        .values({ user_id: userId, started_at: at(40), status: 'ended', ended_at: at(60) })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('sos_events')
      .values({
        id: randomUUID(),
        user_id: userId,
        journey_id: journeyToSos,
        trigger: 'journey',
        started_at: at(45),
        status: 'ended',
        ended_at: at(55),
      })
      .execute();
    await db
      .insertInto('journeys')
      .values({ user_id: userId, started_at: at(70), status: 'lost_contact', ended_at: at(80) })
      .execute();
    await db
      .insertInto('sos_events')
      .values({
        id: randomUUID(),
        user_id: null,
        trigger: 'tile',
        started_at: at(-30),
        status: 'cancelled',
      })
      .execute();
    return { userId, realSos, journeyToSos };
  });
}

/**
 * Alerts for the Alert Log (test database only), all from today: an SMS fixed by the backup
 * provider, an SMS that used every try, a failed push where an SMS got through, a sent SMS.
 */
export async function createAlertsForTest(maxAttempts: number): Promise<{ sosId: string }> {
  const ago = (m: number) => new Date(Date.now() - m * 60_000);
  return withTestDatabase(async (db) => {
    const user = (
      await db
        .insertInto('users')
        .values({ phone: '+919812344521', name: 'Priya' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const g1 = (
      await db
        .insertInto('guardians')
        .values({
          user_id: user,
          name: 'Rohan',
          phone: '+919800000001',
          relation: 'brother',
          invite_status: 'accepted',
          created_at: ago(100),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const g2 = (
      await db
        .insertInto('guardians')
        .values({
          user_id: user,
          name: 'Meera',
          phone: '+919800000002',
          invite_status: 'accepted',
          created_at: ago(90),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const sosId = randomUUID();
    await db
      .insertInto('sos_events')
      .values({ id: sosId, user_id: user, trigger: 'button', started_at: ago(10) })
      .execute();
    const base = { sos_event_id: sosId, type: 'sos' as const };
    await db
      .insertInto('alerts')
      .values([
        {
          ...base,
          guardian_id: g1,
          channel: 'sms',
          provider: 'main',
          status: 'failed',
          attempt: 1,
          created_at: ago(9),
        },
        {
          ...base,
          guardian_id: g1,
          channel: 'sms',
          provider: 'backup',
          status: 'delivered',
          attempt: 2,
          created_at: ago(8),
        },
        {
          ...base,
          guardian_id: g2,
          channel: 'sms',
          provider: 'backup',
          status: 'failed',
          attempt: maxAttempts,
          created_at: ago(7),
        },
        { ...base, guardian_id: g1, channel: 'push', status: 'failed', created_at: ago(6) },
        {
          ...base,
          guardian_id: g2,
          channel: 'sms',
          provider: 'main',
          status: 'sent',
          created_at: ago(30),
        },
      ])
      .execute();
    return { sosId };
  });
}

/**
 * A Dashboard scene (test database only): one user with unfinished setup, an active SOS that no
 * guardian has answered, and an SOS that ended earlier today.
 */
export async function createDashboardSceneForTest(): Promise<{
  activeSos: string;
  endedSos: string;
}> {
  const ago = (m: number) => new Date(Date.now() - m * 60_000);
  return withTestDatabase(async (db) => {
    const user = (
      await db
        .insertInto('users')
        .values({ phone: '+919812344521', name: 'Priya', created_at: ago(60) })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const endedSos = randomUUID();
    const activeSos = randomUUID();
    await db
      .insertInto('sos_events')
      .values([
        {
          id: endedSos,
          user_id: user,
          trigger: 'button',
          started_at: ago(40),
          status: 'ended',
          ended_at: ago(30),
        },
        { id: activeSos, user_id: user, trigger: 'button', started_at: ago(2) },
      ])
      .execute();
    await db
      .insertInto('location_points')
      .values({
        user_id: user,
        sos_event_id: activeSos,
        location: sql<string>`ST_MakePoint(77.3, 28.5)::geography`,
        recorded_at: ago(0.2),
      })
      .execute();
    return { activeSos, endedSos };
  });
}

/**
 * Live SOS scene (test database only): a calm SOS (guardian responding, location 30 s ago) and
 * an SOS with lost contact (last location 9 min ago, nobody responding).
 */
export async function createLiveSceneForTest(): Promise<{ calm: string; lost: string }> {
  const ago = (m: number) => new Date(Date.now() - m * 60_000);
  const point = sql<string>`ST_MakePoint(77.3123, 28.5678)::geography`;
  return withTestDatabase(async (db) => {
    const u1 = (
      await db
        .insertInto('users')
        .values({ phone: '+919811111111', name: 'Priya' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const u2 = (
      await db
        .insertInto('users')
        .values({ phone: '+919822222222', name: 'Rahul' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const calm = randomUUID();
    const lost = randomUUID();
    await db
      .insertInto('sos_events')
      .values([
        { id: calm, user_id: u1, trigger: 'button', started_at: ago(30) },
        { id: lost, user_id: u2, trigger: 'widget', started_at: ago(12) },
      ])
      .execute();
    const g = (
      await db
        .insertInto('guardians')
        .values({
          user_id: u1,
          name: 'Rohan',
          phone: '+919800000001',
          relation: 'brother',
          invite_status: 'accepted',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('alerts')
      .values({
        sos_event_id: calm,
        type: 'sos',
        guardian_id: g,
        channel: 'sms',
        status: 'delivered',
      })
      .execute();
    await db
      .insertInto('guardian_links')
      .values({
        sos_event_id: calm,
        guardian_id: g,
        token_hash: randomUUID(),
        expires_at: ago(-60),
        opened_at: ago(25),
        responding_at: ago(24),
      })
      .execute();
    await db
      .insertInto('location_points')
      .values([
        {
          user_id: u1,
          sos_event_id: calm,
          location: point,
          recorded_at: ago(0.5),
          accuracy_m: 15,
          battery_pct: 42,
          network: '4G',
        },
        {
          user_id: u2,
          sos_event_id: lost,
          location: point,
          recorded_at: ago(9),
          accuracy_m: 30,
          battery_pct: 8,
          network: '2G',
        },
      ])
      .execute();
    return { calm, lost };
  });
}

/** End an SOS as the app would ("I'm safe"). */
export async function endSosForTest(id: string): Promise<void> {
  await withTestDatabase((db) =>
    db
      .updateTable('sos_events')
      .set({ status: 'ended', ended_at: new Date() })
      .where('id', '=', id)
      .execute(),
  );
}

/** How many times an action is in the audit log. */
export async function auditCountForTest(action: string): Promise<number> {
  return withTestDatabase(
    async (db) =>
      (await db.selectFrom('audit_log').select('id').where('action', '=', action).execute()).length,
  );
}

export async function userStatusForTest(id: string): Promise<string | undefined> {
  return withTestDatabase(
    async (db) =>
      (await db.selectFrom('users').select('status').where('id', '=', id).executeTakeFirst())
        ?.status,
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
