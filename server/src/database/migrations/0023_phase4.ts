import { sql, type Kysely } from 'kysely';

/**
 * Phase 4 (customer side): Night Mode state, the partner directory (safe points, women support,
 * lawyers) with its verification lifecycle, support and legal requests, private incident reports,
 * reviewed guidance, and Child Safety (family links, zones, route corridors, alerts).
 * Only structure is added here. No sample partners, guidance, children or reports: every list
 * starts empty until an admin or a real user adds data.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Night Mode is navigation state only: it never starts an SOS, tracking or recording.
    CREATE TABLE night_mode_state (
      user_id    uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
      active     boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- Partner directory. The badge is shown only while status = 'approved' and it has not expired.
    CREATE TABLE partners (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind        text NOT NULL CHECK (kind IN ('safe_point', 'women_support', 'lawyer')),
      name        text NOT NULL,
      category    text NOT NULL,
      location    geography(Point, 4326),
      address     text,
      city        text,
      phone       text CHECK (phone IS NULL OR phone ~ '^\\+?[0-9 ()-]{5,20}$'),
      hours       text,
      languages   text[] NOT NULL DEFAULT '{}',
      services    text,
      status      text NOT NULL DEFAULT 'submitted'
                  CHECK (status IN ('submitted', 'verified', 'approved', 'rejected', 'expired')),
      verified_at timestamptz,
      verified_by uuid REFERENCES admins ON DELETE SET NULL,
      expires_at  timestamptz,
      created_by  uuid REFERENCES admins ON DELETE SET NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX partners_kind_status_idx ON partners (kind, status);
    CREATE INDEX partners_location_idx ON partners USING gist (location);
    CREATE TRIGGER partners_updated_at BEFORE UPDATE ON partners
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- A user's request to a support partner or a lawyer. Made on the phone (id), so a repeat is safe.
    CREATE TABLE partner_requests (
      id                uuid PRIMARY KEY,
      user_id           uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      partner_id        uuid REFERENCES partners ON DELETE SET NULL,
      kind              text NOT NULL CHECK (kind IN ('women_support', 'legal')),
      category          text NOT NULL,
      urgency           text NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low', 'normal', 'urgent')),
      preferred_contact text NOT NULL DEFAULT 'phone' CHECK (preferred_contact IN ('phone', 'sms', 'any')),
      summary           text NOT NULL,
      shared_item_ids   jsonb NOT NULL DEFAULT '[]',
      shared_until      timestamptz,
      status            text NOT NULL DEFAULT 'requested'
                        CHECK (status IN ('requested', 'accepted', 'declined', 'contacted', 'in_progress', 'closed')),
      reference         text NOT NULL UNIQUE,
      internal_note     text,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX partner_requests_user_idx ON partner_requests (user_id, created_at DESC);
    CREATE INDEX partner_requests_status_idx ON partner_requests (status, created_at DESC);
    CREATE TRIGGER partner_requests_updated_at BEFORE UPDATE ON partner_requests
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- What the user sees as the timeline. Rows are only ever added. Internal notes live on the request.
    CREATE TABLE partner_request_events (
      id         bigserial PRIMARY KEY,
      request_id uuid NOT NULL REFERENCES partner_requests ON DELETE CASCADE,
      status     text NOT NULL,
      actor      text NOT NULL CHECK (actor IN ('user', 'admin', 'system')),
      admin_id   uuid REFERENCES admins ON DELETE SET NULL,
      note       text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX partner_request_events_idx ON partner_request_events (request_id, id);

    -- Private incident reports (harassment, workplace, disputed allegation). Admins see counts only.
    CREATE TABLE incident_reports (
      id               uuid PRIMARY KEY,
      user_id          uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      kind             text NOT NULL CHECK (kind IN ('harassment', 'workplace', 'false_accusation')),
      category         text NOT NULL,
      occurred_at      timestamptz NOT NULL,
      place_label      text,
      description      text NOT NULL,
      frequency        text,
      immediate_risk   boolean NOT NULL DEFAULT false,
      organisation     text,
      witness_notes    text,
      details          jsonb NOT NULL DEFAULT '{}',
      evidence_item_ids jsonb NOT NULL DEFAULT '[]',
      route            text NOT NULL DEFAULT 'private'
                       CHECK (route IN ('private', 'guardian', 'legal', 'organisation')),
      partner_request_id uuid REFERENCES partner_requests ON DELETE SET NULL,
      status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'closed')),
      reference        text NOT NULL UNIQUE,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX incident_reports_user_idx ON incident_reports (user_id, created_at DESC);
    CREATE TRIGGER incident_reports_updated_at BEFORE UPDATE ON incident_reports
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE incident_report_events (
      id         bigserial PRIMARY KEY,
      report_id  uuid NOT NULL REFERENCES incident_reports ON DELETE CASCADE,
      action     text NOT NULL,
      note       text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX incident_report_events_idx ON incident_report_events (report_id, id);

    -- Reviewed guidance. The app shows only approved articles whose review date has not passed.
    CREATE TABLE guidance_articles (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      situation  text NOT NULL CHECK (situation IN
        ('threat', 'harassment', 'stalking', 'medical', 'travel', 'child', 'senior')),
      title      text NOT NULL,
      steps      jsonb NOT NULL DEFAULT '[]',
      language   text NOT NULL DEFAULT 'en',
      status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
      reviewed_on date,
      review_due  date,
      approved_by uuid REFERENCES admins ON DELETE SET NULL,
      created_by  uuid REFERENCES admins ON DELETE SET NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX guidance_articles_idx ON guidance_articles (situation, status);
    CREATE TRIGGER guidance_articles_updated_at BEFORE UPDATE ON guidance_articles
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Child Safety: a parent or legal guardian linked to a child's account. Every change is audited.
    CREATE TABLE child_links (
      id             uuid PRIMARY KEY,
      parent_user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      child_user_id  uuid REFERENCES users ON DELETE CASCADE,
      child_name     text NOT NULL,
      child_phone    text NOT NULL CHECK (child_phone ~ '^\\+[1-9][0-9]{7,14}$'),
      status         text NOT NULL DEFAULT 'invited'
                     CHECK (status IN ('invited', 'active', 'declined', 'revoked')),
      accepted_at    timestamptz,
      revoked_at     timestamptz,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX child_links_parent_idx ON child_links (parent_user_id);
    CREATE INDEX child_links_child_idx ON child_links (child_user_id) WHERE status = 'active';
    CREATE INDEX child_links_phone_idx ON child_links (child_phone) WHERE status = 'invited';
    CREATE TRIGGER child_links_updated_at BEFORE UPDATE ON child_links
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE child_link_events (
      id         bigserial PRIMARY KEY,
      link_id    uuid NOT NULL REFERENCES child_links ON DELETE CASCADE,
      action     text NOT NULL,
      actor_user_id uuid REFERENCES users ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE child_zones (
      id         uuid PRIMARY KEY,
      link_id    uuid NOT NULL REFERENCES child_links ON DELETE CASCADE,
      name       text NOT NULL,
      kind       text NOT NULL DEFAULT 'other' CHECK (kind IN ('home', 'school', 'other')),
      center     geography(Point, 4326) NOT NULL,
      radius_m   integer NOT NULL CHECK (radius_m BETWEEN 50 AND 5000),
      inside     boolean,
      changed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX child_zones_link_idx ON child_zones (link_id);

    CREATE TABLE child_routes (
      id          uuid PRIMARY KEY,
      link_id     uuid NOT NULL REFERENCES child_links ON DELETE CASCADE,
      name        text NOT NULL,
      points      jsonb NOT NULL,
      active      boolean NOT NULL DEFAULT true,
      off_since   timestamptz,
      alerted     boolean NOT NULL DEFAULT false,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX child_routes_link_idx ON child_routes (link_id);

    CREATE TABLE child_last_location (
      link_id     uuid PRIMARY KEY REFERENCES child_links ON DELETE CASCADE,
      location    geography(Point, 4326) NOT NULL,
      accuracy_m  real,
      recorded_at timestamptz NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE child_alerts (
      id              bigserial PRIMARY KEY,
      link_id         uuid NOT NULL REFERENCES child_links ON DELETE CASCADE,
      kind            text NOT NULL CHECK (kind IN
        ('zone_enter', 'zone_exit', 'route_deviation', 'stale_gps', 'sos')),
      zone_id         uuid,
      route_id        uuid,
      title           text NOT NULL,
      accuracy_m      real,
      approximate     boolean NOT NULL DEFAULT false,
      rule_version    text,
      acknowledged_at timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX child_alerts_link_idx ON child_alerts (link_id, id DESC);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE child_alerts;
    DROP TABLE child_last_location;
    DROP TABLE child_routes;
    DROP TABLE child_zones;
    DROP TABLE child_link_events;
    DROP TABLE child_links;
    DROP TABLE guidance_articles;
    DROP TABLE incident_report_events;
    DROP TABLE incident_reports;
    DROP TABLE partner_request_events;
    DROP TABLE partner_requests;
    DROP TABLE partners;
    DROP TABLE night_mode_state;
  `.execute(db);
}
