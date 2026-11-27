import { sql, type Kysely } from 'kysely';

/**
 * Phase 4, second group: Chhupa Rakshak sessions, School Monitoring, Cyberbullying Detection,
 * Smart Glasses registry, AI Safety Scoring and the Police / ERSS handoff.
 * Only structure and real configuration (the first scoring model) are added here. No sample
 * schools, datasets, endpoints, flags or devices: every list starts empty.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- ---- P4-06 Chhupa Rakshak: one-way, consented, always visible to the child ----
    CREATE TABLE monitoring_consents (
      link_id        uuid PRIMARY KEY REFERENCES child_links ON DELETE CASCADE,
      enabled        boolean NOT NULL DEFAULT false,
      consent_version text NOT NULL,
      consented_by   uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      consented_at   timestamptz NOT NULL DEFAULT now(),
      media_type     text NOT NULL DEFAULT 'location' CHECK (media_type IN ('location')),
      updated_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE monitoring_sessions (
      id          uuid PRIMARY KEY,
      link_id     uuid NOT NULL REFERENCES child_links ON DELETE CASCADE,
      started_by  uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'expired')),
      end_reason  text CHECK (end_reason IN ('parent_stop', 'child_stop', 'expired', 'permission_lost', 'feature_off')),
      reason      text NOT NULL,
      started_at  timestamptz NOT NULL DEFAULT now(),
      expires_at  timestamptz NOT NULL,
      ended_at    timestamptz
    );
    CREATE INDEX monitoring_sessions_link_idx ON monitoring_sessions (link_id, started_at DESC);
    CREATE UNIQUE INDEX monitoring_one_active ON monitoring_sessions (link_id) WHERE status = 'active';
    CREATE TABLE monitoring_samples (
      id          bigserial PRIMARY KEY,
      session_id  uuid NOT NULL REFERENCES monitoring_sessions ON DELETE CASCADE,
      location    geography(Point, 4326) NOT NULL,
      accuracy_m  real,
      recorded_at timestamptz NOT NULL
    );
    CREATE INDEX monitoring_samples_session_idx ON monitoring_samples (session_id, recorded_at DESC);
    CREATE TABLE monitoring_access_log (
      id          bigserial PRIMARY KEY,
      session_id  uuid NOT NULL REFERENCES monitoring_sessions ON DELETE CASCADE,
      user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      action      text NOT NULL,
      at          timestamptz NOT NULL DEFAULT now()
    );

    -- ---- P4-07 School Monitoring ----
    CREATE TABLE schools (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code           text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]{4,20}$'),
      name           text NOT NULL,
      city           text,
      status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'suspended')),
      secret         text NOT NULL,
      secret_version integer NOT NULL DEFAULT 1,
      last_event_at  timestamptz,
      created_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE school_links (
      id             uuid PRIMARY KEY,
      parent_user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      school_id      uuid NOT NULL REFERENCES schools ON DELETE CASCADE,
      child_name     text NOT NULL,
      student_ref    text NOT NULL,
      status         text NOT NULL DEFAULT 'requested'
                     CHECK (status IN ('requested', 'pending', 'active', 'rejected', 'suspended', 'revoked')),
      note           text,
      decided_by     uuid REFERENCES admins ON DELETE SET NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      UNIQUE (school_id, student_ref, parent_user_id)
    );
    CREATE TABLE school_events (
      id               bigserial PRIMARY KEY,
      school_id        uuid NOT NULL REFERENCES schools ON DELETE CASCADE,
      student_ref      text NOT NULL,
      idempotency_key  text NOT NULL,
      kind             text NOT NULL CHECK (kind IN ('arrived', 'present', 'departed', 'authorised_absence', 'correction')),
      occurred_at      timestamptz NOT NULL,
      received_at      timestamptz NOT NULL DEFAULT now(),
      corrects_key     text,
      reason           text,
      UNIQUE (school_id, idempotency_key)
    );
    CREATE INDEX school_events_student_idx ON school_events (school_id, student_ref, occurred_at DESC);
    CREATE TABLE school_quarantine (
      id          bigserial PRIMARY KEY,
      school_id   uuid REFERENCES schools ON DELETE SET NULL,
      error_type  text NOT NULL,
      detail      text,
      raw         text,
      received_at timestamptz NOT NULL DEFAULT now()
    );

    -- ---- P4-08 Cyberbullying Detection (only content the family chooses to share) ----
    CREATE TABLE cyber_sources (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      link_id     uuid NOT NULL REFERENCES child_links ON DELETE CASCADE,
      kind        text NOT NULL CHECK (kind IN ('shared_text')),
      enabled     boolean NOT NULL DEFAULT false,
      consented_by uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      consented_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (link_id, kind)
    );
    CREATE TABLE cyber_flags (
      id          bigserial PRIMARY KEY,
      link_id     uuid NOT NULL REFERENCES child_links ON DELETE CASCADE,
      source_id   uuid NOT NULL REFERENCES cyber_sources ON DELETE CASCADE,
      submitted_by uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      category    text NOT NULL,
      confidence  text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
      uncertain   boolean NOT NULL,
      excerpt     text,
      explanation text NOT NULL,
      status      text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'false_positive', 'dismissed')),
      note        text,
      created_at  timestamptz NOT NULL DEFAULT now(),
      reviewed_at timestamptz
    );
    CREATE INDEX cyber_flags_link_idx ON cyber_flags (link_id, created_at DESC);

    -- ---- P4-12 Smart Glasses ----
    CREATE TABLE glasses_models (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      manufacturer  text NOT NULL,
      model         text NOT NULL,
      min_firmware  text NOT NULL,
      sdk_version   text,
      capabilities  text[] NOT NULL DEFAULT '{}',
      known_limits  text,
      supported     boolean NOT NULL DEFAULT true,
      created_at    timestamptz NOT NULL DEFAULT now(),
      UNIQUE (manufacturer, model)
    );
    CREATE TABLE user_glasses (
      id           uuid PRIMARY KEY,
      user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      model_id     uuid REFERENCES glasses_models ON DELETE SET NULL,
      device_id    text NOT NULL,
      firmware     text NOT NULL,
      status       text NOT NULL CHECK (status IN ('paired', 'blocked', 'unpaired')),
      block_reason text,
      battery_pct  integer CHECK (battery_pct BETWEEN 0 AND 100),
      last_seen_at timestamptz,
      created_at   timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, device_id)
    );
    CREATE TABLE glasses_captures (
      id            uuid PRIMARY KEY,
      user_glasses_id uuid NOT NULL REFERENCES user_glasses ON DELETE CASCADE,
      incident_id   uuid,
      captured_at   timestamptz NOT NULL,
      file_hash     text,
      capture_state text NOT NULL CHECK (capture_state IN ('recording', 'paused', 'stopped')),
      accuracy_m    real,
      upload_state  text NOT NULL DEFAULT 'queued' CHECK (upload_state IN ('queued', 'uploaded', 'failed')),
      vault_item_id uuid,
      created_at    timestamptz NOT NULL DEFAULT now()
    );

    -- ---- P4-13 AI Safety Scoring ----
    CREATE TABLE safety_datasets (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name           text NOT NULL,
      kind           text NOT NULL CHECK (kind IN ('incident', 'lighting', 'activity', 'support_point')),
      source         text NOT NULL,
      licence        text NOT NULL,
      refresh_days   integer NOT NULL DEFAULT 90 CHECK (refresh_days BETWEEN 1 AND 3650),
      status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
      last_imported_at timestamptz,
      record_count   integer NOT NULL DEFAULT 0,
      created_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE safety_points (
      id          bigserial PRIMARY KEY,
      dataset_id  uuid NOT NULL REFERENCES safety_datasets ON DELETE CASCADE,
      location    geography(Point, 4326) NOT NULL,
      category    text NOT NULL,
      weight      real NOT NULL CHECK (weight BETWEEN 0 AND 1),
      source_time timestamptz,
      imported_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX safety_points_location_idx ON safety_points USING gist (location);
    CREATE TABLE safety_import_rejects (
      id         bigserial PRIMARY KEY,
      dataset_id uuid NOT NULL REFERENCES safety_datasets ON DELETE CASCADE,
      reason     text NOT NULL,
      raw        text,
      at         timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE safety_models (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      version    text NOT NULL UNIQUE,
      config     jsonb NOT NULL,
      active     boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE safety_route_scores (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id        uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      model_version  text NOT NULL,
      input_snapshot jsonb NOT NULL,
      result         jsonb NOT NULL,
      created_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE safety_feedback (
      id             uuid PRIMARY KEY,
      user_id        uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      route_score_id uuid REFERENCES safety_route_scores ON DELETE SET NULL,
      kind           text NOT NULL CHECK (kind IN ('inaccurate', 'unsafe_area', 'closed_road', 'other')),
      message        text NOT NULL,
      status         text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'actioned', 'rejected')),
      reviewed_by    uuid REFERENCES admins ON DELETE SET NULL,
      created_at     timestamptz NOT NULL DEFAULT now()
    );

    -- ---- P4-14 Police / ERSS / CCTNS ----
    CREATE TABLE authority_endpoints (
      id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name                  text NOT NULL,
      kind                  text NOT NULL CHECK (kind IN ('erss', 'cctns')),
      jurisdiction          text NOT NULL,
      environment           text NOT NULL CHECK (environment IN ('sandbox', 'production')),
      base_url              text NOT NULL,
      credential_env        text NOT NULL CHECK (credential_env ~ '^[A-Z][A-Z0-9_]{2,60}$'),
      credential_owner      text NOT NULL,
      credential_expires_at timestamptz,
      permitted_ops         text[] NOT NULL DEFAULT '{}',
      permitted_fields      text[] NOT NULL DEFAULT '{}',
      enabled               boolean NOT NULL DEFAULT false,
      sandbox_passed        boolean NOT NULL DEFAULT false,
      last_health_at        timestamptz,
      last_health_ok        boolean,
      created_at            timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE handoff_attempts (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sos_id          uuid NOT NULL REFERENCES sos_events ON DELETE CASCADE,
      endpoint_id     uuid REFERENCES authority_endpoints ON DELETE SET NULL,
      idempotency_key text NOT NULL UNIQUE,
      status          text NOT NULL CHECK (status IN ('pending', 'sent', 'accepted', 'rejected', 'timed_out', 'fallback', 'acknowledged')),
      error_type      text,
      payload_version text NOT NULL,
      payload         jsonb NOT NULL,
      attempts        integer NOT NULL DEFAULT 0,
      response_ref    text,
      dead_letter     boolean NOT NULL DEFAULT false,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX handoff_attempts_sos_idx ON handoff_attempts (sos_id);
    CREATE TABLE authority_queries (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      endpoint_id uuid NOT NULL REFERENCES authority_endpoints ON DELETE CASCADE,
      admin_id    uuid NOT NULL REFERENCES admins ON DELETE SET NULL,
      purpose     text NOT NULL,
      fields      jsonb NOT NULL,
      status      text NOT NULL,
      reference   text,
      created_at  timestamptz NOT NULL DEFAULT now()
    );

    -- The first scoring model is configuration, not sample data. Weights are ordinary settings
    -- that an admin can replace by adding a newer version and making it the active one.
    INSERT INTO safety_models (version, config, active) VALUES (
      'v1',
      '{"radiusM":150,"sampleEveryM":100,"minCoverage":3,
        "categoryWeights":{"incident":1.0,"lighting":-0.6,"activity":-0.4,"support_point":-0.5},
        "halfLifeDays":365,"bands":[[70,"higher_risk"],[40,"some_risk"],[0,"lower_risk"]]}',
      true
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS authority_queries, handoff_attempts, authority_endpoints,
      safety_feedback, safety_route_scores, safety_models, safety_import_rejects, safety_points,
      safety_datasets, glasses_captures, user_glasses, glasses_models, cyber_flags, cyber_sources,
      school_quarantine, school_events, school_links, schools, monitoring_access_log,
      monitoring_samples, monitoring_sessions, monitoring_consents CASCADE;
  `.execute(db);
}
