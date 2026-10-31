import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Id made on the phone for each point, so a batch sent twice is saved once.
    ALTER TABLE location_points ADD COLUMN client_point_id uuid;
    CREATE UNIQUE INDEX location_points_client_point_idx
      ON location_points (user_id, client_point_id) WHERE client_point_id IS NOT NULL;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX location_points_client_point_idx;
    ALTER TABLE location_points DROP COLUMN client_point_id;
  `.execute(db);
}
