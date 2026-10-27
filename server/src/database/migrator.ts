import { Kysely, PostgresDialect } from 'kysely';
import { Migrator, type Migration } from 'kysely/migration';
import type { Pool } from 'pg';
import * as m0001 from './migrations/0001_extensions';
import * as m0002 from './migrations/0002_core_tables';
import * as m0003 from './migrations/0003_events';
import * as m0004 from './migrations/0004_admin_support';
import * as m0005 from './migrations/0005_audit_log_no_truncate';
import * as m0006 from './migrations/0006_admin_first_login';
import * as m0007 from './migrations/0007_admin_auth';
import * as m0008 from './migrations/0008_settings_audit_details';
import * as m0009 from './migrations/0009_guardian_relation';
import type { Database } from './types';

/** Every migration, in order. Add new ones here (listed by hand so they also load in tests). */
export const migrations: Record<string, Migration> = {
  '0001_extensions': m0001,
  '0002_core_tables': m0002,
  '0003_events': m0003,
  '0004_admin_support': m0004,
  '0005_audit_log_no_truncate': m0005,
  '0006_admin_first_login': m0006,
  '0007_admin_auth': m0007,
  '0008_settings_audit_details': m0008,
  '0009_guardian_relation': m0009,
};

export function createKysely(pool: Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export function createMigrator(db: Kysely<Database>): Migrator {
  return new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
}
