import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- When the phone recorded the clip (it may upload much later, e.g. after being offline).
    ALTER TABLE media_clips ADD COLUMN recorded_at timestamptz;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE media_clips DROP COLUMN recorded_at;`.execute(db);
}
