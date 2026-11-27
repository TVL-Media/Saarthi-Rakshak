import { Kysely, PostgresDialect, sql } from 'kysely';
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
import * as m0010 from './migrations/0010_user_sessions';
import * as m0011 from './migrations/0011_guardian_invites';
import * as m0012 from './migrations/0012_sos_rules';
import * as m0013 from './migrations/0013_location_point_ids';
import * as m0014 from './migrations/0014_journeys';
import * as m0015 from './migrations/0015_places_support';
import * as m0016 from './migrations/0016_audio_recorded_at';
import * as m0017 from './migrations/0017_alerts_timers';
import * as m0018 from './migrations/0018_profile_details';
import * as m0019 from './migrations/0019_phase2';
import * as m0020 from './migrations/0020_phase3_bookings';
import * as m0021 from './migrations/0021_vault_reset';
import * as m0022 from './migrations/0022_rakshak_areas';
import * as m0023 from './migrations/0023_phase4';
import * as m0024 from './migrations/0024_phase4_services';
import * as m0025 from './migrations/0025_rakshak_available';
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
  '0010_user_sessions': m0010,
  '0011_guardian_invites': m0011,
  '0012_sos_rules': m0012,
  '0013_location_point_ids': m0013,
  '0014_journeys': m0014,
  '0015_places_support': m0015,
  '0016_audio_recorded_at': m0016,
  '0017_alerts_timers': m0017,
  '0018_profile_details': m0018,
  '0019_phase2': m0019,
  '0020_phase3_bookings': m0020,
  '0021_vault_reset': m0021,
  '0022_rakshak_areas': m0022,
  '0023_phase4': m0023,
  '0024_phase4_services': m0024,
  '0025_rakshak_available': m0025,
};

export function createKysely(pool: Pool): Kysely<Database> {
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export function createMigrator(db: Kysely<Database>): Migrator {
  return new Migrator({ db, provider: { getMigrations: () => Promise.resolve(migrations) } });
}

/** The lock Kysely holds while migrating (pg_advisory_lock(3853314791062309107)), as pg_locks shows it. */
const LOCK_ID = 3853314791062309107n;
const MIGRATION_LOCK = { classid: Number(LOCK_ID >> 32n), objid: Number(LOCK_ID & 0xffffffffn) };

/**
 * A migration that was cut off (e.g. a deploy cancelled by a newer push) can leave its database
 * session behind, still holding the migration lock. The next migration would then wait up to an
 * hour. A holder that has been idle for longer than `idleMs` is not migrating: end its session.
 * A holder that is busy (a real migration running) is left alone.
 */
export async function clearStaleMigrationLock(
  db: Kysely<Database>,
  idleMs = 2 * 60_000,
): Promise<string[]> {
  const { rows } = await sql<{ pid: number; state: string | null; idle_ms: number }>`
    SELECT a.pid, a.state,
           (EXTRACT(EPOCH FROM (now() - a.state_change)) * 1000)::float8 AS idle_ms
    FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.locktype = 'advisory' AND l.granted
      AND l.classid = ${MIGRATION_LOCK.classid} AND l.objid = ${MIGRATION_LOCK.objid} AND l.objsubid = 1
      AND a.pid <> pg_backend_pid()`.execute(db);
  const notes: string[] = [];
  for (const r of rows) {
    if (r.state === 'idle' && r.idle_ms >= idleMs) {
      const { rows: done } = await sql<{
        ok: boolean;
      }>`SELECT pg_terminate_backend(${r.pid}) AS ok`.execute(db);
      notes.push(
        done[0]?.ok
          ? `Cleared a stale migration lock (session ${r.pid}, idle ${Math.round(r.idle_ms / 1000)} s).`
          : `A stale session (${r.pid}) holds the migration lock and could not be ended.`,
      );
    } else {
      notes.push(
        `Another migration is running (session ${r.pid}, ${r.state ?? 'unknown'}); waiting for it.`,
      );
    }
  }
  return notes;
}
