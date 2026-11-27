import { sql, type Kysely } from 'kysely';

/**
 * "Available now" for approved Rakshaks (owner's go-ahead, 27 Nov 2026): the phone of an
 * approved Rakshak sends its position every few minutes while the switch is on, so they appear in
 * "Rakshaks Near Me". `available_since` is when the switch went on: the server ends the session
 * after `rakshak.available_hours` even if a phone never sends "off". Only the latest position is
 * kept (one row per Rakshak, overwritten): there is no location history of volunteers.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE rakshak_presence ADD COLUMN available_since timestamptz;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE rakshak_presence DROP COLUMN available_since;
  `.execute(db);
}
