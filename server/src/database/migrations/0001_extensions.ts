import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE EXTENSION IF NOT EXISTS postgis;

    -- Keeps updated_at current on every UPDATE (attached to each table that has it).
    CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $$;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // PostGIS is left on: the Docker init script (and DigitalOcean) enable it, not this migration.
  await sql`DROP FUNCTION set_updated_at();`.execute(db);
}
