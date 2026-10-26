import { Injectable } from '@nestjs/common';
import type { Insertable, Kysely, Transaction } from 'kysely';
import type { RequestMeta } from '../common/http';
import { DatabaseService } from '../database/database.module';
import type { AuditLogTable, Database } from '../database/types';

export type AuditEntry = Omit<Insertable<AuditLogTable>, 'ip' | 'user_agent'>;

@Injectable()
export class AuditService {
  constructor(private readonly database: DatabaseService) {}

  /** Writes one audit row. Pass `db` to write inside an open transaction. */
  async record(
    entry: AuditEntry,
    meta?: RequestMeta,
    db: Kysely<Database> | Transaction<Database> = this.database.db,
  ): Promise<void> {
    await db
      .insertInto('audit_log')
      .values({ ...entry, ip: meta?.ip ?? null, user_agent: meta?.userAgent ?? null })
      .execute();
  }
}
