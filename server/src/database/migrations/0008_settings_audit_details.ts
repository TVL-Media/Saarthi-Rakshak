import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Before/after values for a change (setting names and values only; never phone numbers or
    -- names). audit_log stays append-only: its triggers still block UPDATE, DELETE and TRUNCATE.
    ALTER TABLE audit_log ADD COLUMN details jsonb;

    -- "Cancel the SOS countdown without a PIN" is a fixed rule in code, not a setting.
    -- Removes exactly this one row (if the setup command made it), nothing else.
    DELETE FROM settings WHERE key = 'sos.cancel_requires_pin';
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE audit_log DROP COLUMN details;
    INSERT INTO settings (key, value) VALUES ('sos.cancel_requires_pin', 'false')
      ON CONFLICT (key) DO NOTHING;
  `.execute(db);
}
