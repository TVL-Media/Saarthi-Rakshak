import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- Every admin view and action. Append-only: rows can never be changed or deleted.
    -- Holds ids only (no phone numbers or names), so it can be kept after account deletion.
    CREATE TABLE audit_log (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      -- NULL means the system itself (for example, the setup command).
      admin_id    uuid REFERENCES admins,
      action      text NOT NULL,
      target_type text,
      target_id   text,
      reason      text,
      ip          inet,
      user_agent  text,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX audit_log_created_at_idx ON audit_log (created_at);
    CREATE INDEX audit_log_admin_id_idx ON audit_log (admin_id, created_at);
    CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id);

    CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'audit_log is append-only: rows cannot be changed or deleted';
    END;
    $$;
    CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

    CREATE TABLE support_tickets (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id           uuid NOT NULL REFERENCES users ON DELETE CASCADE,
      category          text NOT NULL,
      message           text NOT NULL,
      status            text NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'in_progress', 'closed')),
      assigned_admin_id uuid REFERENCES admins ON DELETE SET NULL,
      closed_at         timestamptz,
      created_at        timestamptz NOT NULL DEFAULT now(),
      updated_at        timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX support_tickets_user_id_idx ON support_tickets (user_id);
    CREATE INDEX support_tickets_status_idx ON support_tickets (status, created_at);

    CREATE TRIGGER support_tickets_updated_at BEFORE UPDATE ON support_tickets
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE support_tickets, audit_log;
    DROP FUNCTION audit_log_append_only();
  `.execute(db);
}
