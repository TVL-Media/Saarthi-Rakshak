import { openTestDatabase, resetTestDatabase } from './test-database';

// Before the whole test run: a clean test database with every migration.
export default async function globalSetup(): Promise<void> {
  const db = await openTestDatabase();
  try {
    await resetTestDatabase(db);
  } finally {
    await db.destroy();
  }
}
