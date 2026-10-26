import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE admins
      -- Set for a temporary password: login must force a new password first (step 5).
      ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
      -- When the temporary password stops working (24 hours after it is issued).
      ADD COLUMN password_expires_at timestamptz;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE admins DROP COLUMN must_change_password, DROP COLUMN password_expires_at;
  `.execute(db);
}
