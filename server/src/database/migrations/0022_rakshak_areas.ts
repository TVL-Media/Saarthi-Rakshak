import { sql, type Kysely } from 'kysely';

/**
 * A Rakshak can help in up to 5 areas (owner's request, 25 Nov 2026). `areas` holds all of them;
 * `area` stays the first (main) one, so apps and screens that read one area keep working.
 * Existing applications get their one area as a one-item list.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE rakshak_applications ADD COLUMN areas text[];
    UPDATE rakshak_applications SET areas = ARRAY[area];
    ALTER TABLE rakshak_applications ALTER COLUMN areas SET NOT NULL;
    ALTER TABLE rakshak_applications ADD CONSTRAINT rakshak_applications_areas_check
      CHECK (cardinality(areas) BETWEEN 1 AND 5 AND areas[1] = area);

    -- Code that writes only "area" (older code, scripts, tests) gets a one-area list.
    CREATE FUNCTION rakshak_applications_default_areas() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.areas IS NULL THEN
        NEW.areas := ARRAY[NEW.area];
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER rakshak_applications_default_areas BEFORE INSERT ON rakshak_applications
      FOR EACH ROW EXECUTE FUNCTION rakshak_applications_default_areas();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TRIGGER rakshak_applications_default_areas ON rakshak_applications;
    DROP FUNCTION rakshak_applications_default_areas();
    ALTER TABLE rakshak_applications DROP CONSTRAINT rakshak_applications_areas_check;
    ALTER TABLE rakshak_applications DROP COLUMN areas;
  `.execute(db);
}
