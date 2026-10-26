import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE admins
      ADD COLUMN failed_login_count  integer NOT NULL DEFAULT 0,
      ADD COLUMN locked_until        timestamptz,
      -- NULL while 2-step is not set up (or was reset); the secret alone is not enough.
      ADD COLUMN totp_enabled_at     timestamptz,
      -- Last accepted authenticator time step, so a code can never be used twice.
      ADD COLUMN totp_last_step      bigint,
      ADD COLUMN password_changed_at timestamptz;

    CREATE TABLE admin_sessions (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_id     uuid NOT NULL REFERENCES admins ON DELETE CASCADE,
      -- SHA-256 of the cookie value; the cookie value itself is never stored.
      token_hash   text NOT NULL UNIQUE,
      stage        text NOT NULL
                   CHECK (stage IN ('change_password', 'setup_2fa', 'verify_2fa', 'full')),
      ip           inet,
      user_agent   text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      expires_at   timestamptz NOT NULL,
      ended_at     timestamptz,
      end_reason   text
    );
    CREATE INDEX admin_sessions_open_idx ON admin_sessions (admin_id) WHERE ended_at IS NULL;

    CREATE TABLE admin_backup_codes (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_id   uuid NOT NULL REFERENCES admins ON DELETE CASCADE,
      -- HMAC-SHA256 with a server-side key; the code itself is never stored.
      code_hash  text NOT NULL,
      used_at    timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX admin_backup_codes_admin_id_idx ON admin_backup_codes (admin_id);

    ALTER TABLE audit_log
      ADD COLUMN session_id  uuid,
      ADD COLUMN status_code smallint;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE audit_log DROP COLUMN session_id, DROP COLUMN status_code;
    DROP TABLE admin_backup_codes, admin_sessions;
    ALTER TABLE admins
      DROP COLUMN failed_login_count,
      DROP COLUMN locked_until,
      DROP COLUMN totp_enabled_at,
      DROP COLUMN totp_last_step,
      DROP COLUMN password_changed_at;
  `.execute(db);
}
