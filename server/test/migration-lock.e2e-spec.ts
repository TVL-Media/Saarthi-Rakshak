import { sql, type Kysely } from 'kysely';
import { Client } from 'pg';
import { activeConnections, validateEnv } from '../src/config/env.schema';
import { clearStaleMigrationLock, createMigrator } from '../src/database/migrator';
import type { Database } from '../src/database/types';
import { openTestDatabase } from './test-database';

let db: Kysely<Database>;
const url = () => activeConnections(validateEnv(process.env)).databaseUrl;

beforeAll(async () => {
  db = await openTestDatabase();
});

afterAll(async () => {
  await db?.destroy();
});

/** A session left behind by a cut-off migration: holds Kysely's lock and does nothing. */
async function leftBehindSession(): Promise<Client> {
  const c = new Client({ connectionString: url() });
  c.on('error', () => undefined); // it is ended from the server side on purpose
  await c.connect();
  await c.query('SELECT pg_advisory_lock(3853314791062309107)');
  return c;
}

describe('stale migration lock', () => {
  it('ends an idle session that holds the lock, so migrations do not wait an hour', async () => {
    const stale = await leftBehindSession();
    expect(await clearStaleMigrationLock(db, 0)).toEqual([
      expect.stringMatching(/^Cleared a stale migration lock/),
    ]);
    // The lock is free again: the migrator runs straight away.
    const { error } = await createMigrator(db).migrateToLatest();
    expect(error).toBeUndefined();
    await stale.end().catch(() => undefined);
  });

  it('leaves a recent holder alone (a migration that is still running)', async () => {
    const holder = await leftBehindSession();
    expect(await clearStaleMigrationLock(db)).toEqual([
      expect.stringMatching(/^Another migration is running/),
    ]);
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted`.execute(db);
    expect(rows[0].n).toBeGreaterThan(0);
    await holder.end();
  });

  it('does nothing when no one holds the lock', async () => {
    expect(await clearStaleMigrationLock(db, 0)).toEqual([]);
  });
});
