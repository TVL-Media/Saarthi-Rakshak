import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Invite link for each guardian: only a hash of the link code is stored.
    ALTER TABLE guardians
      ADD COLUMN invite_token_hash text UNIQUE,
      ADD COLUMN invite_expires_at timestamptz;

    -- Numbers that declined a user's invite, so that user can't invite them again.
    -- Only a keyed hash of the number is kept (PHONE_HASH_KEY), never the number itself.
    CREATE TABLE guardian_invite_blocklist (
      user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      phone_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, phone_hash)
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE guardian_invite_blocklist;
    ALTER TABLE guardians DROP COLUMN invite_token_hash, DROP COLUMN invite_expires_at;
  `.execute(db);
}
