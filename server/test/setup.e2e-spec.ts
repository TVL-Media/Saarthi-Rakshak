import { sql, type Kysely } from 'kysely';
import { verifyPassword } from '../src/auth/password';
import { createMigrator, migrations } from '../src/database/migrator';
import type { Database } from '../src/database/types';
import { DEFAULT_SETTINGS } from '../src/settings/default-settings';
import {
  SetupError,
  createFirstSuperAdmin,
  insertDefaultSettings,
  reissueSuperAdminPassword,
} from '../src/setup/setup';
import { TABLES, openTestDatabase, resetTestDatabase } from './test-database';

// The setup command commits real rows, so the test database is reset before every test.
let db: Kysely<Database>;
const HOUR_MS = 60 * 60 * 1000;
const FIRST = { name: 'Test Super Admin', email: 'First.Admin@Example.test' };

beforeAll(async () => {
  db = await openTestDatabase();
});
beforeEach(async () => {
  await resetTestDatabase(db);
});
afterAll(async () => {
  await db?.destroy();
});

const admins = () => db.selectFrom('admins').selectAll().execute();
const auditActions = async () =>
  (await db.selectFrom('audit_log').select('action').orderBy('id').execute()).map((r) => r.action);

describe('test database reset', () => {
  it('leaves every migration applied and zero rows in every table', async () => {
    const applied = await createMigrator(db).getMigrations();
    expect(applied.map((m) => [m.name, Boolean(m.executedAt)])).toEqual(
      Object.keys(migrations).map((name) => [name, true]),
    );
    for (const table of TABLES) {
      const { rows } = await sql<{
        n: string;
      }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(db);
      expect([table, Number(rows[0].n)]).toEqual([table, 0]);
    }
  });
});

describe('insertDefaultSettings', () => {
  it('adds every default with the right value', async () => {
    const added = await insertDefaultSettings(db);
    expect(added.sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());

    const rows = await db.selectFrom('settings').select(['key', 'value']).execute();
    expect(Object.fromEntries(rows.map((r) => [r.key, r.value]))).toEqual(
      Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([k, d]) => [k, d.value])),
    );
    expect(await auditActions()).toEqual(['setup.settings_added']);
  });

  it('changes nothing when run a second time', async () => {
    await insertDefaultSettings(db);
    expect(await insertDefaultSettings(db)).toEqual([]);
    expect(await auditActions()).toEqual(['setup.settings_added']);
  });

  it('never overwrites a value that was changed', async () => {
    await insertDefaultSettings(db);
    await db
      .updateTable('settings')
      .set({ value: JSON.stringify(8) })
      .where('key', '=', 'sos.countdown_seconds')
      .execute();
    await insertDefaultSettings(db);
    const row = await db
      .selectFrom('settings')
      .select('value')
      .where('key', '=', 'sos.countdown_seconds')
      .executeTakeFirstOrThrow();
    expect(row.value).toBe(8);
  });

  it('adds only the missing ones', async () => {
    await insertDefaultSettings(db);
    // settings rows have no protection trigger; deleting one simulates a newly added default.
    await db.deleteFrom('settings').where('key', '=', 'guardian.max_count').execute();
    expect(await insertDefaultSettings(db)).toEqual(['guardian.max_count']);
  });
});

describe('createFirstSuperAdmin', () => {
  it('creates one Super Admin with a temporary password that must be changed', async () => {
    const before = Date.now();
    const issued = await createFirstSuperAdmin(db, FIRST);

    const rows = await admins();
    expect(rows).toHaveLength(1);
    const [admin] = rows;
    expect(admin).toMatchObject({
      id: issued.adminId,
      name: 'Test Super Admin',
      email: 'first.admin@example.test',
      role: 'super_admin',
      status: 'active',
      must_change_password: true,
    });
    expect(await verifyPassword(issued.temporaryPassword, admin.password_hash)).toBe(true);
    expect(admin.password_hash).not.toContain(issued.temporaryPassword);

    const expires = admin.password_expires_at!.getTime();
    expect(expires).toBeGreaterThanOrEqual(before + 24 * HOUR_MS - 1000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 24 * HOUR_MS + 1000);

    const audit = await db.selectFrom('audit_log').selectAll().execute();
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'setup.super_admin_created',
        admin_id: null,
        target_type: 'admin',
        target_id: issued.adminId,
      }),
    ]);
  });

  it('refuses when a Super Admin already exists', async () => {
    await createFirstSuperAdmin(db, FIRST);
    await expect(
      createFirstSuperAdmin(db, { name: 'Second', email: 'second@example.test' }),
    ).rejects.toThrow(/A Super Admin already exists/);
    expect(await admins()).toHaveLength(1);
  });

  it('refuses even when the existing Super Admin is disabled', async () => {
    await createFirstSuperAdmin(db, FIRST);
    await db.updateTable('admins').set({ status: 'disabled' }).execute();
    await expect(
      createFirstSuperAdmin(db, { name: 'Second', email: 'second@example.test' }),
    ).rejects.toBeInstanceOf(SetupError);
    expect(await admins()).toHaveLength(1);
  });

  it('refuses two runs at the same moment (only one Super Admin is created)', async () => {
    const results = await Promise.allSettled([
      createFirstSuperAdmin(db, FIRST),
      createFirstSuperAdmin(db, { name: 'Other', email: 'other@example.test' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await admins()).toHaveLength(1);
  });

  it.each([
    [{ name: '  ', email: 'a@example.test' }, /Name must not be empty/],
    [{ name: 'A', email: 'not-an-email' }, /not a valid email/],
  ])('refuses bad input %j with a clear message', async (input, message) => {
    await expect(createFirstSuperAdmin(db, input)).rejects.toThrow(message);
    expect(await admins()).toHaveLength(0);
  });
});

describe('reissueSuperAdminPassword (break-glass)', () => {
  it('issues a new temporary password; the old one stops working', async () => {
    const first = await createFirstSuperAdmin(db, FIRST);
    await db
      .updateTable('admins')
      .set({ password_expires_at: new Date(Date.now() - HOUR_MS) })
      .execute();

    const issued = await reissueSuperAdminPassword(db, { email: 'FIRST.admin@example.test' });
    expect(issued).toMatchObject({ adminId: first.adminId, reEnabled: false });

    const [admin] = await admins();
    expect(await verifyPassword(issued.temporaryPassword, admin.password_hash)).toBe(true);
    expect(await verifyPassword(first.temporaryPassword, admin.password_hash)).toBe(false);
    expect(admin.must_change_password).toBe(true);
    expect(admin.password_expires_at!.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR_MS);

    expect(await auditActions()).toEqual([
      'setup.super_admin_created',
      'setup.super_admin_reissued',
    ]);
  });

  it('re-enables a disabled Super Admin and says so in the audit log', async () => {
    await createFirstSuperAdmin(db, FIRST);
    await db.updateTable('admins').set({ status: 'disabled' }).execute();

    const issued = await reissueSuperAdminPassword(db, { email: FIRST.email });
    expect(issued.reEnabled).toBe(true);
    const [admin] = await admins();
    expect(admin.status).toBe('active');

    const entry = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'setup.super_admin_reissued')
      .executeTakeFirstOrThrow();
    expect(entry.target_id).toBe(admin.id);
    expect(entry.reason).toMatch(/re-enabled/);
  });

  it('never creates a Super Admin', async () => {
    await expect(reissueSuperAdminPassword(db, { email: FIRST.email })).rejects.toThrow(
      /is not an existing Super Admin/,
    );
    expect(await admins()).toHaveLength(0);
    expect(await auditActions()).toEqual([]);
  });

  it('refuses an email that belongs to a Support Admin', async () => {
    await createFirstSuperAdmin(db, FIRST);
    await db
      .insertInto('admins')
      .values({
        name: 'Support',
        email: 'support@example.test',
        role: 'support_admin',
        password_hash: 'x',
      })
      .execute();
    await expect(
      reissueSuperAdminPassword(db, { email: 'support@example.test' }),
    ).rejects.toBeInstanceOf(SetupError);
    const support = await db
      .selectFrom('admins')
      .select(['role', 'password_hash'])
      .where('email', '=', 'support@example.test')
      .executeTakeFirstOrThrow();
    expect(support).toEqual({ role: 'support_admin', password_hash: 'x' });
  });
});
