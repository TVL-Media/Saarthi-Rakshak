import { sql, type Kysely } from 'kysely';

// TRUNCATE skips row triggers, so audit_log also needs a statement-level block.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
      FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER audit_log_no_truncate ON audit_log;`.execute(db);
}
