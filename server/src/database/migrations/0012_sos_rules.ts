import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Copy of the safety rules (Settings) when the SOS started. Timers read this copy, so a
    -- settings change never changes an SOS that is already running.
    ALTER TABLE sos_events ADD COLUMN rules jsonb;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE sos_events DROP COLUMN rules;`.execute(db);
}
