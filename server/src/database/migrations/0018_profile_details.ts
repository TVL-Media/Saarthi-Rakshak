import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- More profile details, all optional. Only the user sees them in the app: they are not shown
    -- to guardians or in the admin panel, and they go with the users row when the account is deleted.
    ALTER TABLE users
      ADD COLUMN gender text CHECK (gender IN ('female', 'male', 'other')),
      ADD COLUMN date_of_birth date,
      ADD COLUMN email text CHECK (char_length(email) <= 120),
      ADD COLUMN home_address text CHECK (char_length(home_address) <= 300),
      ADD COLUMN medical_notes text CHECK (char_length(medical_notes) <= 500);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE users
      DROP COLUMN gender,
      DROP COLUMN date_of_birth,
      DROP COLUMN email,
      DROP COLUMN home_address,
      DROP COLUMN medical_notes;
  `.execute(db);
}
