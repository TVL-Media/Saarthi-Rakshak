// Command line for `pnpm app:setup` (see setup-args.ts for the options).
import { Pool } from 'pg';
import { loadEnvFile } from '../config/env';
import { activeConnections, validateEnv } from '../config/env.schema';
import { createKysely } from '../database/migrator';
import { DEFAULT_SETTINGS } from '../settings/default-settings';
import { parseSetupArgs } from './setup-args';
import {
  SetupError,
  TEMP_PASSWORD_VALID_HOURS,
  createFirstSuperAdmin,
  insertDefaultSettings,
  reissueSuperAdminPassword,
  type IssuedPassword,
} from './setup';

async function main(): Promise<void> {
  const args = parseSetupArgs(process.argv.slice(2));
  if (args.test) process.env.NODE_ENV = 'test';

  loadEnvFile();
  const { databaseUrl } = activeConnections(validateEnv(process.env));
  const db = createKysely(new Pool({ connectionString: databaseUrl }));
  console.log(`Database: ${new URL(databaseUrl).pathname.slice(1)}`);

  try {
    const added = await insertDefaultSettings(db);
    const total = Object.keys(DEFAULT_SETTINGS).length;
    console.log(
      added.length > 0
        ? `Settings: added ${added.length} of ${total} defaults.`
        : `Settings: added 0 (all ${total} defaults already present).`,
    );

    if (args.mode === 'create') {
      const issued = await createFirstSuperAdmin(db, args);
      console.log(`Super Admin created: ${issued.email}`);
      printPassword(issued);
    } else if (args.mode === 'reissue') {
      const issued = await reissueSuperAdminPassword(db, args);
      console.log(
        `New temporary password issued for Super Admin ${issued.email}` +
          (issued.reEnabled ? ' (account re-enabled).' : '.'),
      );
      printPassword(issued);
    }
  } finally {
    await db.destroy();
  }
}

function printPassword({ temporaryPassword, expiresAt }: IssuedPassword): void {
  console.log('');
  console.log('  Temporary password (shown ONCE, not saved anywhere):');
  console.log('');
  console.log(`      ${temporaryPassword}`);
  console.log('');
  console.log(`  Valid for ${TEMP_PASSWORD_VALID_HOURS} hours (until ${expiresAt.toISOString()}).`);
  console.log('  It must be changed at first login.');
}

main().catch((err: unknown) => {
  console.error(err instanceof SetupError ? `Refused: ${err.message}` : err);
  process.exit(1);
});
