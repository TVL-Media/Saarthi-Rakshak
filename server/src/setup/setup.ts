import { sql, type Kysely, type Transaction } from 'kysely';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { generateTemporaryPassword, hashPassword } from '../auth/password';
import type { Database } from '../database/types';
import { DEFAULT_SETTINGS } from '../settings/default-settings';

export const TEMP_PASSWORD_VALID_HOURS = 24;

/** A refusal with a message meant for the person running the command. */
export class SetupError extends Error {}

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Email is not a valid email address' }));
export const nameSchema = z.string().trim().min(1, { error: 'Name must not be empty' });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new SetupError(result.error.issues[0].message);
  return result.data;
}

/** Only one setup action at a time, so two people can never create two Super Admins. */
async function lockSetup(trx: Transaction<Database>): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext('sarthi.setup'))`.execute(trx);
}

/** A one-time password (shown once) with its hash and 24-hour expiry. */
export async function issueTemporaryPassword() {
  const temporaryPassword = generateTemporaryPassword();
  return {
    temporaryPassword,
    passwordHash: await hashPassword(temporaryPassword),
    expiresAt: new Date(Date.now() + TEMP_PASSWORD_VALID_HOURS * 60 * 60 * 1000),
  };
}

/** Adds every default setting that is missing. Never overwrites. Returns the keys added. */
export async function insertDefaultSettings(db: Kysely<Database>): Promise<string[]> {
  return db.transaction().execute(async (trx) => {
    await lockSetup(trx);
    const added = await trx
      .insertInto('settings')
      .values(
        Object.entries(DEFAULT_SETTINGS).map(([key, def]) => ({
          key,
          value: JSON.stringify(def.value),
        })),
      )
      .onConflict((oc) => oc.column('key').doNothing())
      .returning('key')
      .execute();

    const keys = added.map((row) => row.key);
    if (keys.length > 0) {
      await trx
        .insertInto('audit_log')
        .values({
          action: 'setup.settings_added',
          target_type: 'settings',
          target_id: keys.join(','),
        })
        .execute();
    }
    return keys;
  });
}

export interface IssuedPassword {
  adminId: string;
  email: string;
  /** Shown once in the terminal. Never stored or logged. */
  temporaryPassword: string;
  expiresAt: Date;
}

/** Creates the first Super Admin. Refuses if any Super Admin exists (active or disabled). */
export async function createFirstSuperAdmin(
  db: Kysely<Database>,
  input: { name: string; email: string },
): Promise<IssuedPassword> {
  const name = parse(nameSchema, input.name);
  const email = parse(emailSchema, input.email);

  return db.transaction().execute(async (trx) => {
    await lockSetup(trx);
    const existing = await trx
      .selectFrom('admins')
      .select('id')
      .where('role', '=', 'super_admin')
      .executeTakeFirst();
    if (existing) {
      throw new SetupError(
        'A Super Admin already exists. Add more admins from the Admin Team screen, ' +
          'or use --reissue if the Super Admin is locked out.',
      );
    }
    const sameEmail = await trx
      .selectFrom('admins')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirst();
    if (sameEmail) throw new SetupError(`An admin with the email ${email} already exists.`);

    const issued = await issueTemporaryPassword();
    const admin = await trx
      .insertInto('admins')
      .values({
        name,
        email,
        role: 'super_admin',
        password_hash: issued.passwordHash,
        must_change_password: true,
        password_expires_at: issued.expiresAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await trx
      .insertInto('audit_log')
      .values({ action: 'setup.super_admin_created', target_type: 'admin', target_id: admin.id })
      .execute();

    return {
      adminId: admin.id,
      email,
      temporaryPassword: issued.temporaryPassword,
      expiresAt: issued.expiresAt,
    };
  });
}

/**
 * Break-glass: a new temporary password for an EXISTING Super Admin (expired temporary
 * password, or the only Super Admin disabled). Re-enables the account. Never creates an admin.
 */
export async function reissueSuperAdminPassword(
  db: Kysely<Database>,
  input: { email: string },
): Promise<IssuedPassword & { reEnabled: boolean }> {
  const email = parse(emailSchema, input.email);

  return db.transaction().execute(async (trx) => {
    await lockSetup(trx);
    const admin = await trx
      .selectFrom('admins')
      .select(['id', 'status'])
      .where('email', '=', email)
      .where('role', '=', 'super_admin')
      .executeTakeFirst();
    if (!admin) throw new SetupError(`${email} is not an existing Super Admin.`);

    const issued = await issueTemporaryPassword();
    // Break-glass: new temporary password, 2-step cleared (set up again at login),
    // lockout cleared, account re-enabled, and every open session ended.
    await trx
      .updateTable('admins')
      .set({
        password_hash: issued.passwordHash,
        must_change_password: true,
        password_expires_at: issued.expiresAt,
        status: 'active',
        totp_secret_encrypted: null,
        totp_enabled_at: null,
        totp_last_step: null,
        failed_login_count: 0,
        locked_until: null,
      })
      .where('id', '=', admin.id)
      .execute();
    await trx.deleteFrom('admin_backup_codes').where('admin_id', '=', admin.id).execute();
    await trx
      .updateTable('admin_sessions')
      .set({ ended_at: new Date(), end_reason: 'reissued by setup command' })
      .where('admin_id', '=', admin.id)
      .where('ended_at', 'is', null)
      .execute();

    const reEnabled = admin.status === 'disabled';
    await trx
      .insertInto('audit_log')
      .values({
        action: 'setup.super_admin_reissued',
        target_type: 'admin',
        target_id: admin.id,
        reason:
          'Temporary password reissued; 2-step setup cleared; all sessions ended' +
          (reEnabled ? '; account re-enabled' : ''),
      })
      .execute();

    return {
      adminId: admin.id,
      email,
      temporaryPassword: issued.temporaryPassword,
      expiresAt: issued.expiresAt,
      reEnabled,
    };
  });
}

/**
 * Test servers only (ADMIN_TEMP_EMAIL + ADMIN_TEMP_PASSWORD, refused in production): gives the
 * Super Admin with that email this temporary password, or creates the first Super Admin if there
 * is none. Applied ONCE per password (a fingerprint of it is kept in the audit log, never the
 * password), so the password the admin then chooses is not overwritten at the next restart.
 * Like --reissue: must be changed at login, 2-step set up again, sessions ended.
 */
export async function applyTempAdminPassword(
  db: Kysely<Database>,
  input: { email: string; password: string },
): Promise<'applied' | 'created' | 'already applied' | 'not a super admin'> {
  const email = parse(emailSchema, input.email);
  const marker = `temp-password:${createHash('sha256').update(`${email}\n${input.password}`).digest('hex').slice(0, 16)}`;
  return db.transaction().execute(async (trx) => {
    await lockSetup(trx);
    const done = await trx
      .selectFrom('audit_log')
      .select('id')
      .where('action', '=', 'setup.temp_password_applied')
      .where('reason', 'like', `%${marker}%`)
      .executeTakeFirst();
    if (done) return 'already applied';

    const passwordHash = await hashPassword(input.password);
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600_000);
    const admin = await trx
      .selectFrom('admins')
      .select(['id', 'role'])
      .where('email', '=', email)
      .executeTakeFirst();
    let id: string;
    let result: 'applied' | 'created';
    if (admin) {
      if (admin.role !== 'super_admin') return 'not a super admin';
      await trx
        .updateTable('admins')
        .set({
          password_hash: passwordHash,
          must_change_password: true,
          password_expires_at: expiresAt,
          status: 'active',
          totp_secret_encrypted: null,
          totp_enabled_at: null,
          totp_last_step: null,
          failed_login_count: 0,
          locked_until: null,
        })
        .where('id', '=', admin.id)
        .execute();
      await trx.deleteFrom('admin_backup_codes').where('admin_id', '=', admin.id).execute();
      await trx
        .updateTable('admin_sessions')
        .set({ ended_at: new Date(), end_reason: 'temporary password set' })
        .where('admin_id', '=', admin.id)
        .where('ended_at', 'is', null)
        .execute();
      id = admin.id;
      result = 'applied';
    } else {
      const anySuper = await trx
        .selectFrom('admins')
        .select('id')
        .where('role', '=', 'super_admin')
        .executeTakeFirst();
      if (anySuper) return 'not a super admin';
      const created = await trx
        .insertInto('admins')
        .values({
          name: 'Super Admin',
          email,
          role: 'super_admin',
          password_hash: passwordHash,
          must_change_password: true,
          password_expires_at: expiresAt,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      id = created.id;
      result = 'created';
    }
    await trx
      .insertInto('audit_log')
      .values({
        action: 'setup.temp_password_applied',
        target_type: 'admin',
        target_id: id,
        reason: `Temporary password from the server settings (test server); 2-step cleared; ${marker}`,
      })
      .execute();
    return result;
  });
}
