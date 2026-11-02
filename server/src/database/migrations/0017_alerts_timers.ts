import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Every kind of guardian message now gets an alerts row; delivery reports find it by the
    -- provider's message id.
    ALTER TABLE alerts
      DROP CONSTRAINT alerts_type_check,
      ADD CONSTRAINT alerts_type_check CHECK (type IN (
        'sos', 'sos_link', 'resend', 'lost_contact', 'back_online', 'checkin_no_reply', 'safe',
        'cancelled', 'invite', 'test', 'journey_started', 'journey_arrived', 'journey_ended')),
      ADD COLUMN provider_message_id text,
      -- The SMS text while it waits to be sent; cleared once sent or finally failed (it holds
      -- the guardian's secret link).
      ADD COLUMN body text;
    CREATE INDEX alerts_provider_message_id_idx ON alerts (provider_message_id)
      WHERE provider_message_id IS NOT NULL;

    -- Safety timers: "no guardian responded" sent once; lost contact (phone silent) and back.
    ALTER TABLE sos_events
      ADD COLUMN no_response_alerted_at timestamptz,
      ADD COLUMN lost_contact_at timestamptz;
    ALTER TABLE journeys ADD COLUMN lost_contact_at timestamptz;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE journeys DROP COLUMN lost_contact_at;
    ALTER TABLE sos_events DROP COLUMN no_response_alerted_at, DROP COLUMN lost_contact_at;
    DROP INDEX alerts_provider_message_id_idx;
    DELETE FROM alerts WHERE type NOT IN
      ('sos', 'resend', 'lost_contact', 'checkin_no_reply', 'safe', 'cancelled');
    ALTER TABLE alerts
      DROP COLUMN provider_message_id,
      DROP COLUMN body,
      DROP CONSTRAINT alerts_type_check,
      ADD CONSTRAINT alerts_type_check CHECK (type IN
        ('sos', 'resend', 'lost_contact', 'checkin_no_reply', 'safe', 'cancelled'));
  `.execute(db);
}
