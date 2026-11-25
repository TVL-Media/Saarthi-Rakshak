import { sql, type Kysely } from 'kysely';

/**
 * Mere Saboot reset ("Forgot password"): the vault password cannot be recovered, so a user can
 * start a new vault. Evidence that is still protected from deletion cannot be deleted at once:
 * it is marked here (it can never be opened again), hidden from the user, and deleted by the
 * hourly cleanup when its protection ends. The reset itself is kept in the access history.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE evidence_items ADD COLUMN orphaned_at timestamptz;
    CREATE INDEX evidence_items_orphaned_idx ON evidence_items (delete_locked_until)
      WHERE orphaned_at IS NOT NULL;

    ALTER TABLE evidence_access_log DROP CONSTRAINT evidence_access_log_action_check;
    ALTER TABLE evidence_access_log ADD CONSTRAINT evidence_access_log_action_check CHECK (action IN
      ('created', 'viewed', 'exported', 'shared', 'edited', 'hidden', 'unhidden', 'deleted', 'report',
       'reset'));
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- The access history cannot be changed (a trigger refuses it), so "reset" rows stay: the old
    -- rule is put back for new rows only (NOT VALID).
    ALTER TABLE evidence_access_log DROP CONSTRAINT evidence_access_log_action_check;
    ALTER TABLE evidence_access_log ADD CONSTRAINT evidence_access_log_action_check CHECK (action IN
      ('created', 'viewed', 'exported', 'shared', 'edited', 'hidden', 'unhidden', 'deleted', 'report'))
      NOT VALID;
    DROP INDEX evidence_items_orphaned_idx;
    ALTER TABLE evidence_items DROP COLUMN orphaned_at;
  `.execute(db);
}
