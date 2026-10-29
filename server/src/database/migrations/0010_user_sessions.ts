import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Which version of the terms and privacy text the user accepted (with consent_at).
    ALTER TABLE users
      ADD COLUMN consent_version text CHECK (char_length(consent_version) BETWEEN 1 AND 20);

    -- App login sessions. The app sends the token as "Authorization: Bearer <token>".
    CREATE TABLE user_sessions (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      -- Filled in when the app reports its phone (step A2).
      device_id    uuid REFERENCES devices ON DELETE SET NULL,
      -- SHA-256 of the token; the token itself is never stored.
      token_hash   text NOT NULL UNIQUE,
      created_at   timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      -- Pushed forward when the app is used (90 days of no use ends it).
      expires_at   timestamptz NOT NULL,
      ended_at     timestamptz,
      end_reason   text CHECK (end_reason IN ('logout', 'new_login', 'account_deleted')),
      CHECK ((ended_at IS NULL) = (end_reason IS NULL))
    );
    CREATE INDEX user_sessions_open_idx ON user_sessions (user_id) WHERE ended_at IS NULL;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE user_sessions;
    ALTER TABLE users DROP COLUMN consent_version;
  `.execute(db);
}
