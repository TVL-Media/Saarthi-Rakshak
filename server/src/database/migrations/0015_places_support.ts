import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Saved places for Start journey: one Home, one Work, a few others.
    CREATE TABLE saved_places (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      label      text NOT NULL CHECK (label IN ('home', 'work', 'other')),
      name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
      address    text CHECK (char_length(address) <= 200),
      location   geography(Point, 4326) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX saved_places_user_id_idx ON saved_places (user_id);
    CREATE UNIQUE INDEX saved_places_one_home_work_idx ON saved_places (user_id, label)
      WHERE label IN ('home', 'work');
    CREATE TRIGGER saved_places_updated_at BEFORE UPDATE ON saved_places
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Report a problem: which app build and phone the user had.
    ALTER TABLE support_tickets
      ADD COLUMN app_version  text CHECK (char_length(app_version) <= 40),
      ADD COLUMN device_model text CHECK (char_length(device_model) <= 80);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE support_tickets DROP COLUMN app_version, DROP COLUMN device_model;
    DROP TABLE saved_places;
  `.execute(db);
}
