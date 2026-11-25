import { sql, type Kysely } from 'kysely';

/**
 * Phase 3 (customer side): the service list, bookings with their full history, and where
 * verified Rakshaks are right now (written by the Rakshak app later; empty until then).
 * Only real configuration is added here: the four services. No sample bookings or Rakshaks.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE booking_services (
      id          text PRIMARY KEY,
      name        text NOT NULL,
      description text NOT NULL,
      position    integer NOT NULL,
      active      boolean NOT NULL DEFAULT true
    );
    INSERT INTO booking_services (id, name, description, position) VALUES
      ('pre_booking', 'Pre-booking',
        'Book a Rakshak ahead of time for a trip, an event or a late night.', 1),
      ('invisible_rakshak', 'Invisible Rakshak',
        'A Rakshak keeps a discreet distance and watches over you.', 2),
      ('home_guard', 'Home Guard',
        'A Rakshak stays at your home for the time you choose.', 3),
      ('senior_visit', 'Senior Safety Visit',
        'A Rakshak visits an older family member and checks on them.', 4);

    CREATE TABLE bookings (
      id               uuid PRIMARY KEY,
      user_id          uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      service_type     text NOT NULL REFERENCES booking_services,
      window_start     timestamptz NOT NULL,
      window_end       timestamptz NOT NULL,
      place            geography(Point, 4326) NOT NULL,
      place_label      text,
      notes            text,
      status           text NOT NULL DEFAULT 'requested' CHECK (status IN
        ('requested', 'quoted', 'confirmed', 'assigned', 'in_progress', 'completed', 'cancelled')),
      quote_amount_paise integer CHECK (quote_amount_paise IS NULL OR quote_amount_paise >= 0),
      quote_note       text,
      quote_expires_at timestamptz,
      rakshak_user_id  uuid REFERENCES users ON DELETE SET NULL,
      cancel_reason    text,
      created_at       timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now(),
      CHECK (window_end > window_start)
    );
    CREATE INDEX bookings_user_idx ON bookings (user_id, created_at DESC);
    CREATE INDEX bookings_status_idx ON bookings (status, created_at DESC);
    CREATE TRIGGER bookings_updated_at BEFORE UPDATE ON bookings
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Every change to a booking, with who did it. Rows are only ever added.
    CREATE TABLE booking_events (
      id         bigserial PRIMARY KEY,
      booking_id uuid NOT NULL REFERENCES bookings ON DELETE CASCADE,
      status     text NOT NULL,
      actor      text NOT NULL CHECK (actor IN ('user', 'rakshak', 'admin', 'system')),
      admin_id   uuid REFERENCES admins ON DELETE SET NULL,
      note       text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX booking_events_booking_idx ON booking_events (booking_id, id);

    -- Where an online Rakshak is. Written by the Rakshak app (not built yet), read for "near me".
    CREATE TABLE rakshak_presence (
      user_id    uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
      location   geography(Point, 4326) NOT NULL,
      accuracy_m real,
      online     boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX rakshak_presence_location_idx ON rakshak_presence USING gist (location)
      WHERE online;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE rakshak_presence;
    DROP TABLE booking_events;
    DROP TABLE bookings;
    DROP TABLE booking_services;
  `.execute(db);
}
