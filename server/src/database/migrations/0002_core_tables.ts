import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE users (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Full number in E.164 form (needed to send SMS); the admin API shows it masked.
      phone        text NOT NULL UNIQUE CHECK (phone ~ '^\\+[1-9][0-9]{7,14}$'),
      name         text,
      photo_key    text,
      blood_group  text CHECK (blood_group IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
      status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
      consent_at   timestamptz,
      last_seen_at timestamptz,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE devices (
      id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id                  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      model                    text,
      android_version          text,
      app_version              text,
      push_token               text,
      permissions              jsonb NOT NULL DEFAULT '{}',
      battery_optimisation_off boolean,
      last_seen_at             timestamptz,
      created_at               timestamptz NOT NULL DEFAULT now(),
      updated_at               timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX devices_user_id_idx ON devices (user_id);

    CREATE TABLE guardians (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      name          text NOT NULL,
      phone         text CHECK (phone ~ '^\\+[1-9][0-9]{7,14}$'),
      invite_status text NOT NULL DEFAULT 'pending'
                    CHECK (invite_status IN ('pending', 'accepted', 'declined')),
      invited_at    timestamptz NOT NULL DEFAULT now(),
      responded_at  timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, phone),
      -- Someone who declines must not keep their number on file.
      CONSTRAINT guardians_declined_has_no_phone CHECK (invite_status <> 'declined' OR phone IS NULL),
      CONSTRAINT guardians_active_has_phone CHECK (invite_status = 'declined' OR phone IS NOT NULL)
    );
    CREATE INDEX guardians_user_id_idx ON guardians (user_id);

    CREATE TABLE admins (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email                 text NOT NULL UNIQUE CHECK (email = lower(email)),
      name                  text NOT NULL,
      role                  text NOT NULL CHECK (role IN ('super_admin', 'support_admin')),
      password_hash         text NOT NULL,
      -- Authenticator-app secret, encrypted by the server before saving (step 5).
      totp_secret_encrypted text,
      status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      last_login_at         timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE settings (
      key        text PRIMARY KEY,
      value      jsonb NOT NULL,
      updated_by uuid REFERENCES admins ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER devices_updated_at BEFORE UPDATE ON devices
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER guardians_updated_at BEFORE UPDATE ON guardians
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER admins_updated_at BEFORE UPDATE ON admins
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER settings_updated_at BEFORE UPDATE ON settings
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE settings, admins, guardians, devices, users;`.execute(db);
}
