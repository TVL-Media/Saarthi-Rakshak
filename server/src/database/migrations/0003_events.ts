import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE journeys (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id             uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      destination         geography(Point, 4326),
      destination_label   text,
      expected_arrival_at timestamptz,
      status              text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'arrived', 'ended', 'lost_contact')),
      started_at          timestamptz NOT NULL DEFAULT now(),
      ended_at            timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX journeys_user_id_idx ON journeys (user_id);
    CREATE INDEX journeys_active_idx ON journeys (started_at) WHERE status = 'active';

    -- Kept (anonymised) when a user deletes their account, so pilot reports still work.
    CREATE TABLE sos_events (
      -- Made on the phone, so a retried upload never creates a duplicate.
      id                       uuid PRIMARY KEY,
      user_id                  uuid REFERENCES users ON DELETE SET NULL,
      journey_id               uuid REFERENCES journeys ON DELETE SET NULL,
      trigger                  text NOT NULL
                               CHECK (trigger IN ('button', 'widget', 'tile', 'checkin', 'journey')),
      is_test                  boolean NOT NULL DEFAULT false,
      status                   text NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'ended', 'cancelled')),
      started_at               timestamptz NOT NULL,
      ended_at                 timestamptz,
      end_reason               text,
      guardian_link_expires_at timestamptz,
      created_at               timestamptz NOT NULL DEFAULT now(),
      updated_at               timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX sos_events_user_id_idx ON sos_events (user_id);
    CREATE INDEX sos_events_started_at_idx ON sos_events (started_at);
    CREATE INDEX sos_events_active_idx ON sos_events (started_at) WHERE status = 'active';

    -- SOS records are history: core facts never change and rows are never deleted.
    -- The only allowed change to user_id is setting it to NULL (account deletion).
    CREATE FUNCTION sos_events_protect() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'sos_events rows cannot be deleted';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.trigger IS DISTINCT FROM OLD.trigger
         OR NEW.is_test IS DISTINCT FROM OLD.is_test
         OR NEW.started_at IS DISTINCT FROM OLD.started_at
         OR (NEW.user_id IS DISTINCT FROM OLD.user_id AND NEW.user_id IS NOT NULL) THEN
        RAISE EXCEPTION 'sos_events core facts (id, user_id, trigger, is_test, started_at) cannot be changed';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER sos_events_protect BEFORE UPDATE OR DELETE ON sos_events
      FOR EACH ROW EXECUTE FUNCTION sos_events_protect();

    CREATE TABLE location_points (
      id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      sos_event_id uuid REFERENCES sos_events,
      journey_id   uuid REFERENCES journeys ON DELETE CASCADE,
      location     geography(Point, 4326) NOT NULL,
      accuracy_m   real,
      battery_pct  smallint CHECK (battery_pct BETWEEN 0 AND 100),
      network      text,
      recorded_at  timestamptz NOT NULL,
      -- Set by the server from a retention setting; a cleanup job removes points after this.
      delete_after timestamptz,
      created_at   timestamptz NOT NULL DEFAULT now(),
      CHECK (sos_event_id IS NOT NULL OR journey_id IS NOT NULL)
    );
    CREATE INDEX location_points_sos_idx ON location_points (sos_event_id, recorded_at);
    CREATE INDEX location_points_journey_idx ON location_points (journey_id, recorded_at);
    CREATE INDEX location_points_user_id_idx ON location_points (user_id);
    CREATE INDEX location_points_delete_after_idx ON location_points (delete_after)
      WHERE delete_after IS NOT NULL;

    CREATE TABLE checkins (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      journey_id  uuid NOT NULL REFERENCES journeys ON DELETE CASCADE,
      reason      text NOT NULL CHECK (reason IN ('off_route', 'stopped', 'late')),
      status      text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'fine', 'traffic_pause', 'sos', 'no_reply')),
      asked_at    timestamptz NOT NULL DEFAULT now(),
      answered_at timestamptz,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX checkins_journey_id_idx ON checkins (journey_id);

    -- One row per send attempt. No phone numbers or names here: provider errors must be
    -- stored without personal details, so rows can be kept after account deletion.
    CREATE TABLE alerts (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sos_event_id uuid REFERENCES sos_events,
      journey_id   uuid REFERENCES journeys ON DELETE SET NULL,
      guardian_id  uuid REFERENCES guardians ON DELETE SET NULL,
      channel      text NOT NULL CHECK (channel IN ('push', 'sms', 'sim_sms')),
      provider     text CHECK (provider IN ('main', 'backup')),
      type         text NOT NULL CHECK (type IN
                     ('sos', 'resend', 'lost_contact', 'checkin_no_reply', 'safe', 'cancelled')),
      status       text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'sent', 'delivered', 'failed')),
      attempt      smallint NOT NULL DEFAULT 1 CHECK (attempt >= 1),
      error        text,
      sent_at      timestamptz,
      delivered_at timestamptz,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX alerts_sos_event_id_idx ON alerts (sos_event_id);
    CREATE INDEX alerts_journey_id_idx ON alerts (journey_id);
    CREATE INDEX alerts_guardian_id_idx ON alerts (guardian_id);
    CREATE INDEX alerts_status_idx ON alerts (status, created_at);

    CREATE TABLE guardian_links (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      guardian_id   uuid NOT NULL REFERENCES guardians ON DELETE CASCADE,
      sos_event_id  uuid REFERENCES sos_events,
      journey_id    uuid REFERENCES journeys ON DELETE CASCADE,
      -- Only a hash of the secret link code is stored, never the code itself.
      token_hash    text NOT NULL UNIQUE,
      opened_at     timestamptz,
      responding_at timestamptz,
      expires_at    timestamptz NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now(),
      CHECK (sos_event_id IS NOT NULL OR journey_id IS NOT NULL)
    );
    CREATE INDEX guardian_links_guardian_id_idx ON guardian_links (guardian_id);
    CREATE INDEX guardian_links_sos_event_id_idx ON guardian_links (sos_event_id);

    -- No URL column on purpose: admins can never play or download audio.
    CREATE TABLE media_clips (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      sos_event_id uuid NOT NULL REFERENCES sos_events,
      storage_key  text NOT NULL UNIQUE,
      duration_s   integer CHECK (duration_s >= 0),
      size_bytes   bigint CHECK (size_bytes >= 0),
      keep         boolean NOT NULL DEFAULT false,
      delete_after timestamptz NOT NULL,
      deleted_at   timestamptz,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX media_clips_sos_event_id_idx ON media_clips (sos_event_id);
    CREATE INDEX media_clips_user_id_idx ON media_clips (user_id);
    CREATE INDEX media_clips_delete_after_idx ON media_clips (delete_after)
      WHERE deleted_at IS NULL AND NOT keep;

    CREATE TRIGGER journeys_updated_at BEFORE UPDATE ON journeys
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER sos_events_updated_at BEFORE UPDATE ON sos_events
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER checkins_updated_at BEFORE UPDATE ON checkins
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER alerts_updated_at BEFORE UPDATE ON alerts
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER guardian_links_updated_at BEFORE UPDATE ON guardian_links
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    CREATE TRIGGER media_clips_updated_at BEFORE UPDATE ON media_clips
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE media_clips, guardian_links, alerts, checkins, location_points, sos_events, journeys;
    DROP FUNCTION sos_events_protect();
  `.execute(db);
}
