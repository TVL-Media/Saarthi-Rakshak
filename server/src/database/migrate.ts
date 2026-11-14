// Command line: node dist/database/migrate.js <latest|down|status> [--test]
// --test runs against DATABASE_URL_TEST instead of DATABASE_URL.
import type { MigrationResultSet } from 'kysely/migration';
import { Pool } from 'pg';
import { loadEnvFile } from '../config/env';
import { activeConnections, validateEnv } from '../config/env.schema';
import { clearStaleMigrationLock, createKysely, createMigrator } from './migrator';

const COMMANDS = ['latest', 'down', 'status'] as const;

async function main(): Promise<void> {
  const [command, ...flags] = process.argv.slice(2);
  if (!COMMANDS.includes(command as (typeof COMMANDS)[number])) {
    throw new Error(`Usage: migrate <${COMMANDS.join('|')}> [--test]`);
  }
  if (flags.includes('--test')) process.env.NODE_ENV = 'test';

  loadEnvFile();
  const env = validateEnv(process.env);
  const { databaseUrl } = activeConnections(env);
  const db = createKysely(
    new Pool({
      connectionString: databaseUrl,
      application_name: 'sarthi-migrate',
      keepAlive: true,
    }),
  );
  console.log(`Database: ${new URL(databaseUrl).pathname.slice(1)}`);

  try {
    const migrator = createMigrator(db);
    if (command !== 'status') {
      for (const note of await clearStaleMigrationLock(db)) console.log(`  ${note}`);
    }
    if (command === 'status') {
      for (const m of await migrator.getMigrations()) {
        console.log(`  ${m.executedAt ? 'done   ' : 'pending'}  ${m.name}`);
      }
      return;
    }
    report(command === 'latest' ? await migrator.migrateToLatest() : await migrator.migrateDown());
  } finally {
    await db.destroy();
  }
}

function report({ error, results }: MigrationResultSet): void {
  if (results?.length === 0) console.log('  Nothing to do.');
  for (const r of results ?? []) {
    console.log(
      `  ${r.status.padEnd(7)}  ${r.direction === 'Up' ? 'up  ' : 'down'}  ${r.migrationName}`,
    );
  }
  if (error) throw error instanceof Error ? error : new Error('Migration failed', { cause: error });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
