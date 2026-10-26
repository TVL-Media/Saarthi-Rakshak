import { sql, type Kysely } from 'kysely';
import { NO_MIGRATIONS } from 'kysely/migration';
import { Pool } from 'pg';
import { loadEnvFile } from '../src/config/env';
import { activeConnections, validateEnv } from '../src/config/env.schema';
import { createKysely, createMigrator } from '../src/database/migrator';
import type { Database } from '../src/database/types';

/** Every table the migrations create. */
export const TABLES = [
  'admin_backup_codes',
  'admin_sessions',
  'admins',
  'alerts',
  'audit_log',
  'checkins',
  'devices',
  'guardian_links',
  'guardians',
  'journeys',
  'location_points',
  'media_clips',
  'settings',
  'sos_events',
  'support_tickets',
  'users',
] as const satisfies readonly (keyof Database)[];

/** Connects to the test database, and refuses if it is not one (name must end in _test). */
export async function openTestDatabase(): Promise<Kysely<Database>> {
  process.env.NODE_ENV = 'test';
  loadEnvFile();
  const { databaseUrl } = activeConnections(validateEnv(process.env));
  const db = createKysely(new Pool({ connectionString: databaseUrl }));

  const { rows } = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db);
  if (!rows[0].name.endsWith('_test')) {
    await db.destroy();
    throw new Error(`Refusing to touch "${rows[0].name}": tests only run on a *_test database`);
  }
  return db;
}

/** Undoes every migration (drops all tables, including audit_log), then runs them all again. */
export async function resetTestDatabase(db: Kysely<Database>): Promise<void> {
  await wipeTestDatabase(db);
  check(await createMigrator(db).migrateToLatest());
}

/** Undoes every migration, leaving no tables and no rows. */
export async function wipeTestDatabase(db: Kysely<Database>): Promise<void> {
  check(await createMigrator(db).migrateTo(NO_MIGRATIONS));
}

function check({ error }: { error?: unknown }): void {
  if (error) throw error instanceof Error ? error : new Error('Migration failed', { cause: error });
}
