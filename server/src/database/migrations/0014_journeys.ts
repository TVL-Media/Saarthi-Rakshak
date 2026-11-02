import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE journeys
      -- Copy of the safety rules (Settings) when the journey started; timers read this copy.
      ADD COLUMN rules jsonb,
      -- Route from Google Directions (encoded polyline) for the guardian page; optional.
      ADD COLUMN route_polyline text CHECK (char_length(route_polyline) <= 20000),
      -- "Stuck in traffic": no new check-ins until then.
      ADD COLUMN checkins_paused_until timestamptz;

    -- Who raised the check-in: the phone (stopped, off route, late) or the server (backup).
    ALTER TABLE checkins
      ADD COLUMN source text NOT NULL DEFAULT 'phone' CHECK (source IN ('phone', 'server'));
    CREATE INDEX checkins_pending_idx ON checkins (asked_at) WHERE status = 'pending';

    -- Journey live links are looked up by journey.
    CREATE INDEX guardian_links_journey_id_idx ON guardian_links (journey_id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX guardian_links_journey_id_idx;
    DROP INDEX checkins_pending_idx;
    ALTER TABLE checkins DROP COLUMN source;
    ALTER TABLE journeys DROP COLUMN rules, DROP COLUMN route_polyline, DROP COLUMN checkins_paused_until;
  `.execute(db);
}
