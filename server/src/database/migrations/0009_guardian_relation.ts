import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- How the guardian is related to the user, if the user says (e.g. "brother"). Optional.
    ALTER TABLE guardians
      ADD COLUMN relation text CHECK (relation IS NULL OR char_length(relation) BETWEEN 1 AND 40);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE guardians DROP COLUMN relation;`.execute(db);
}
