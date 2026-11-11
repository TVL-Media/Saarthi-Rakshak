import { sql, type Kysely } from 'kysely';

/**
 * Phase 2: new SOS triggers, SOS photos, full-day location, the evidence vault, the community
 * feed, Rakshak sign-up and plans. Evidence is encrypted on the phone: the server only stores
 * locked files, locked keys and locked details it cannot read.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- New ways to raise an SOS.
    ALTER TABLE sos_events DROP CONSTRAINT sos_events_trigger_check;
    ALTER TABLE sos_events ADD CONSTRAINT sos_events_trigger_check CHECK (trigger IN
      ('button', 'widget', 'tile', 'checkin', 'journey', 'shake', 'voice', 'crash', 'fall', 'discreet'));

    -- How the user travels (drive mode / crash detection needs a vehicle).
    ALTER TABLE journeys ADD COLUMN mode text
      CHECK (mode IN ('walk', 'cab', 'auto', 'bus', 'own_vehicle'));

    -- Cancelled detection countdowns (counts only, to tune the thresholds).
    CREATE TABLE sos_false_alarms (
      id         uuid PRIMARY KEY,
      user_id    uuid REFERENCES users ON DELETE SET NULL,
      trigger    text NOT NULL CHECK (trigger IN ('shake', 'voice', 'crash', 'fall', 'discreet', 'button', 'widget', 'tile')),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX sos_false_alarms_created_idx ON sos_false_alarms (created_at);

    CREATE TABLE sos_trigger_settings (
      user_id            uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
      shake_mode         text NOT NULL DEFAULT 'off' CHECK (shake_mode IN ('off', 'journey', 'always')),
      voice_on           boolean NOT NULL DEFAULT false,
      drive_mode         boolean NOT NULL DEFAULT false,
      fall_on            boolean NOT NULL DEFAULT false,
      quiet_countdown    boolean NOT NULL DEFAULT false,
      journey_sos_button boolean NOT NULL DEFAULT true,
      updated_at         timestamptz NOT NULL DEFAULT now()
    );
    CREATE TRIGGER sos_trigger_settings_updated_at BEFORE UPDATE ON sos_trigger_settings
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Front and back photos taken while the SOS screen is open. Guardians see them on the live
    -- page; admins never. Deleted after the audio retention unless the user keeps them.
    CREATE TABLE sos_photos (
      id           uuid PRIMARY KEY,
      user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      sos_event_id uuid NOT NULL REFERENCES sos_events,
      camera       text NOT NULL CHECK (camera IN ('front', 'back')),
      storage_key  text NOT NULL,
      size_bytes   integer NOT NULL,
      taken_at     timestamptz NOT NULL,
      keep         boolean NOT NULL DEFAULT false,
      delete_after timestamptz NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX sos_photos_sos_idx ON sos_photos (sos_event_id, taken_at);
    CREATE INDEX sos_photos_delete_after_idx ON sos_photos (delete_after) WHERE keep = false;

    -- Full-day location (optional, only with the user's consent).
    CREATE TABLE daily_tracking_settings (
      user_id         uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
      enabled         boolean NOT NULL DEFAULT false,
      paused_until    timestamptz,
      retention_days  smallint NOT NULL DEFAULT 30 CHECK (retention_days IN (7, 30, 90)),
      consent_version text,
      consent_at      timestamptz,
      updated_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE TRIGGER daily_tracking_settings_updated_at BEFORE UPDATE ON daily_tracking_settings
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Every point now says what it belongs to; full-day points belong to no SOS or journey.
    ALTER TABLE location_points ADD COLUMN kind text NOT NULL DEFAULT 'journey'
      CHECK (kind IN ('sos', 'journey', 'daily'));
    UPDATE location_points SET kind = 'sos' WHERE sos_event_id IS NOT NULL;
    ALTER TABLE location_points ALTER COLUMN kind DROP DEFAULT;
    -- Points sent without a kind get it from what they belong to (SOS first).
    CREATE FUNCTION location_points_kind() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.kind IS NULL THEN
        NEW.kind := CASE WHEN NEW.sos_event_id IS NOT NULL THEN 'sos'
                         WHEN NEW.journey_id IS NOT NULL THEN 'journey'
                         ELSE 'daily' END;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER location_points_kind BEFORE INSERT ON location_points
      FOR EACH ROW EXECUTE FUNCTION location_points_kind();
    ALTER TABLE location_points DROP CONSTRAINT location_points_check;
    ALTER TABLE location_points ADD CONSTRAINT location_points_owner_check
      CHECK (sos_event_id IS NOT NULL OR journey_id IS NOT NULL OR kind = 'daily');
    CREATE INDEX location_points_daily_idx ON location_points (user_id, recorded_at)
      WHERE kind = 'daily';

    -- Evidence vault. The vault key is locked with the user's recovery phrase on the phone;
    -- the server keeps only that locked copy (it cannot open it).
    CREATE TABLE vault_keys (
      user_id     uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
      locked_key  text NOT NULL,
      kdf         jsonb NOT NULL,
      check_value text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE TRIGGER vault_keys_updated_at BEFORE UPDATE ON vault_keys
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE evidence_incidents (
      id             uuid PRIMARY KEY,
      user_id        uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      kind           text NOT NULL CHECK (kind IN ('blackmail', 'harassment', 'physical', 'sos', 'other')),
      -- Title, date and description, encrypted on the phone.
      locked_details text NOT NULL,
      sos_event_id   uuid REFERENCES sos_events ON DELETE SET NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      deleted_at     timestamptz
    );
    CREATE INDEX evidence_incidents_user_idx ON evidence_incidents (user_id, created_at);
    CREATE UNIQUE INDEX evidence_incidents_sos_idx ON evidence_incidents (user_id, sos_event_id)
      WHERE sos_event_id IS NOT NULL;
    CREATE TRIGGER evidence_incidents_updated_at BEFORE UPDATE ON evidence_incidents
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE evidence_items (
      id                 uuid PRIMARY KEY,
      user_id            uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      incident_id        uuid REFERENCES evidence_incidents ON DELETE SET NULL,
      kind               text NOT NULL CHECK (kind IN ('audio', 'video', 'photo', 'file', 'detail', 'report')),
      -- NULL for a "detail" item (number, email, link): all of it is in locked_details.
      storage_key        text,
      size_bytes         bigint NOT NULL DEFAULT 0,
      -- The item's own file key, locked with the vault key (phone only can unlock).
      locked_file_key    text NOT NULL,
      -- Place, note, original file name, detail value: encrypted on the phone.
      locked_details     text NOT NULL,
      sha256             text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      captured_at        timestamptz NOT NULL,
      received_at        timestamptz NOT NULL DEFAULT now(),
      delete_locked_until timestamptz NOT NULL,
      hidden             boolean NOT NULL DEFAULT false,
      uploaded           boolean NOT NULL DEFAULT false,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX evidence_items_user_idx ON evidence_items (user_id, captured_at);
    CREATE INDEX evidence_items_incident_idx ON evidence_items (incident_id);
    CREATE TRIGGER evidence_items_updated_at BEFORE UPDATE ON evidence_items
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Tamper evidence: the fingerprint and the time we first received it never change.
    CREATE FUNCTION evidence_items_protect() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.sha256 IS DISTINCT FROM OLD.sha256
         OR NEW.received_at IS DISTINCT FROM OLD.received_at
         OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
         OR NEW.user_id IS DISTINCT FROM OLD.user_id
         OR NEW.kind IS DISTINCT FROM OLD.kind THEN
        RAISE EXCEPTION 'evidence fingerprints and times cannot be changed';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER evidence_items_protect BEFORE UPDATE ON evidence_items
      FOR EACH ROW EXECUTE FUNCTION evidence_items_protect();

    -- What the user did with her evidence (no content). Never edited; removed only with the account.
    CREATE TABLE evidence_access_log (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      item_id     uuid,
      incident_id uuid,
      action      text NOT NULL CHECK (action IN
        ('created', 'viewed', 'exported', 'shared', 'edited', 'hidden', 'unhidden', 'deleted', 'report')),
      device      text,
      at          timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX evidence_access_log_user_idx ON evidence_access_log (user_id, at);
    CREATE FUNCTION evidence_access_log_protect() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'evidence_access_log rows cannot be changed';
    END;
    $$;
    CREATE TRIGGER evidence_access_log_protect BEFORE UPDATE ON evidence_access_log
      FOR EACH ROW EXECUTE FUNCTION evidence_access_log_protect();

    -- Community safety feed: nothing is shown until an admin approves it.
    CREATE TABLE community_posts (
      id              uuid PRIMARY KEY,
      author_user_id  uuid REFERENCES users ON DELETE SET NULL,
      author_admin_id uuid REFERENCES admins ON DELETE SET NULL,
      category        text NOT NULL CHECK (category IN ('lighting', 'unsafe_spot', 'harassment_area', 'road', 'other')),
      area            text NOT NULL,
      body            text NOT NULL CHECK (char_length(body) BETWEEN 20 AND 500),
      photo_key       text,
      status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'rejected', 'removed')),
      reason          text,
      reviewed_by     uuid REFERENCES admins ON DELETE SET NULL,
      reviewed_at     timestamptz,
      flags_count     integer NOT NULL DEFAULT 0,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX community_posts_area_idx ON community_posts (area, created_at) WHERE status = 'published';
    CREATE INDEX community_posts_status_idx ON community_posts (status, created_at);
    CREATE INDEX community_posts_author_idx ON community_posts (author_user_id, created_at);
    CREATE TRIGGER community_posts_updated_at BEFORE UPDATE ON community_posts
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE community_flags (
      post_id    uuid NOT NULL REFERENCES community_posts ON DELETE CASCADE,
      user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      reason     text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 300),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (post_id, user_id)
    );

    -- Rakshak sign-up (Phase 3 pool). Personal details are encrypted with the server key
    -- (admins must review them); only the last 4 digits of the ID number are kept.
    CREATE TABLE rakshak_applications (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id        uuid REFERENCES users ON DELETE CASCADE,
      locked_details text NOT NULL,
      area           text NOT NULL,
      id_type        text NOT NULL CHECK (id_type IN ('aadhaar', 'pan', 'driving_licence', 'voter_id', 'passport')),
      id_last4       text NOT NULL CHECK (id_last4 ~ '^[0-9A-Z]{4}$'),
      documents      jsonb NOT NULL DEFAULT '{}'::jsonb,
      consent_at     timestamptz NOT NULL,
      status         text NOT NULL DEFAULT 'under_review'
                       CHECK (status IN ('under_review', 'approved', 'rejected', 'withdrawn')),
      reason         text,
      reviewed_by    uuid REFERENCES admins ON DELETE SET NULL,
      decided_at     timestamptz,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX rakshak_applications_open_idx ON rakshak_applications (user_id)
      WHERE status IN ('under_review', 'approved');
    CREATE INDEX rakshak_applications_status_idx ON rakshak_applications (status, created_at);
    CREATE TRIGGER rakshak_applications_updated_at BEFORE UPDATE ON rakshak_applications
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Plans (Basic, Silver, Gold). While no prices are set, every feature is free for everyone.
    CREATE TABLE plans (
      id                 text PRIMARY KEY CHECK (id IN ('basic', 'silver', 'gold')),
      name               text NOT NULL,
      monthly_price_inr  integer CHECK (monthly_price_inr >= 0),
      yearly_price_inr   integer CHECK (yearly_price_inr >= 0),
      monthly_product_id text,
      yearly_product_id  text,
      features           jsonb NOT NULL DEFAULT '[]'::jsonb,
      evidence_storage_mb integer NOT NULL DEFAULT 2048,
      location_history_days smallint NOT NULL DEFAULT 90,
      on_sale            boolean NOT NULL DEFAULT false,
      sort_order         smallint NOT NULL,
      updated_by         uuid REFERENCES admins ON DELETE SET NULL,
      updated_at         timestamptz NOT NULL DEFAULT now()
    );
    CREATE TRIGGER plans_updated_at BEFORE UPDATE ON plans
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    INSERT INTO plans (id, name, features, evidence_storage_mb, location_history_days, sort_order) VALUES
      ('basic', 'Basic', '["SOS, guardians and live location", "Journeys and check-ins", "Evidence vault"]'::jsonb, 2048, 90, 1),
      ('silver', 'Silver', '["Everything in Basic", "More evidence storage"]'::jsonb, 10240, 90, 2),
      ('gold', 'Gold', '["Everything in Silver", "Most evidence storage"]'::jsonb, 51200, 90, 3);

    CREATE TABLE subscriptions (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id             uuid REFERENCES users ON DELETE SET NULL,
      plan_id             text NOT NULL REFERENCES plans,
      product_id          text NOT NULL,
      purchase_token_hash text NOT NULL UNIQUE,
      status              text NOT NULL CHECK (status IN ('active', 'pending', 'cancelled', 'expired', 'refunded')),
      renews_at           timestamptz,
      cancelled_at        timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX subscriptions_user_idx ON subscriptions (user_id, created_at);
    CREATE TRIGGER subscriptions_updated_at BEFORE UPDATE ON subscriptions
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE subscriptions;
    DROP TABLE plans;
    DROP TABLE rakshak_applications;
    DROP TABLE community_flags;
    DROP TABLE community_posts;
    DROP TABLE evidence_access_log;
    DROP FUNCTION evidence_access_log_protect();
    DROP TABLE evidence_items;
    DROP FUNCTION evidence_items_protect();
    DROP TABLE evidence_incidents;
    DROP TABLE vault_keys;
    DELETE FROM location_points WHERE kind = 'daily';
    DROP INDEX location_points_daily_idx;
    ALTER TABLE location_points DROP CONSTRAINT location_points_owner_check;
    ALTER TABLE location_points ADD CONSTRAINT location_points_check
      CHECK (sos_event_id IS NOT NULL OR journey_id IS NOT NULL);
    DROP TRIGGER location_points_kind ON location_points;
    DROP FUNCTION location_points_kind();
    ALTER TABLE location_points DROP COLUMN kind;
    DROP TABLE daily_tracking_settings;
    DROP TABLE sos_photos;
    DROP TABLE sos_trigger_settings;
    DROP TABLE sos_false_alarms;
    ALTER TABLE journeys DROP COLUMN mode;
    ALTER TABLE sos_events DROP CONSTRAINT sos_events_trigger_check;
    -- SOS rows are never changed or deleted, so ones raised by a Phase 2 trigger stay as they are.
    ALTER TABLE sos_events ADD CONSTRAINT sos_events_trigger_check CHECK (trigger IN
      ('button', 'widget', 'tile', 'checkin', 'journey')) NOT VALID;
  `.execute(db);
}
