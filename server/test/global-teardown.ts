import { openTestDatabase, wipeTestDatabase } from './test-database';

// After the whole test run: no test records are left anywhere.
export default async function globalTeardown(): Promise<void> {
  const db = await openTestDatabase();
  try {
    await wipeTestDatabase(db);
  } finally {
    await db.destroy();
  }
}
