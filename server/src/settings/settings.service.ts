import { ConflictException, Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { AuditService } from '../audit/audit.service';
import type { AuthedAdmin, RequestMeta } from '../common/http';
import { DatabaseService } from '../database/database.module';
import type { Database } from '../database/types';
import { DEFAULT_SETTINGS, type SettingKey } from './default-settings';

export interface SettingView {
  key: SettingKey;
  /** null if the setup command has not saved it yet. */
  value: number | null;
  min: number;
  max: number;
}

export interface SettingsView {
  /** Changes when any setting changes; sent back on save to catch two admins editing at once. */
  version: string;
  settings: SettingView[];
}

export const SETTINGS_CHANGED_ELSEWHERE =
  'Settings were changed by someone else. Reload to see them.';

type Db = Kysely<Database> | Transaction<Database>;

@Injectable()
export class SettingsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async view(db: Db = this.database.db): Promise<SettingsView> {
    const rows = await db
      .selectFrom('settings')
      .select(['key', 'value', sql<string>`updated_at::text`.as('updated')])
      .execute();
    const saved = new Map(rows.map((r) => [r.key, r]));
    const version = rows
      .map((r) => `${r.key}@${r.updated}`)
      .sort()
      .join('|');
    return {
      version,
      settings: (Object.keys(DEFAULT_SETTINGS) as SettingKey[]).map((key) => {
        const value = saved.get(key)?.value;
        return {
          key,
          value: typeof value === 'number' ? value : null,
          min: DEFAULT_SETTINGS[key].min,
          max: DEFAULT_SETTINGS[key].max,
        };
      }),
    };
  }

  /**
   * Saves changed values (already checked against their ranges) in one transaction, with one
   * audit row per change holding the before/after values and the reason. Values equal to the
   * current ones are ignored. Refused if someone saved since `version` was read.
   */
  async change(
    actor: AuthedAdmin,
    input: { version: string; reason: string; values: Partial<Record<SettingKey, number>> },
    meta: RequestMeta,
  ): Promise<{ changed: number; view: SettingsView }> {
    return this.database.db.transaction().execute(async (trx) => {
      // Lock the settings so two saves cannot interleave.
      await sql`LOCK TABLE settings IN SHARE ROW EXCLUSIVE MODE`.execute(trx);
      const current = await this.view(trx);
      if (current.version !== input.version)
        throw new ConflictException(SETTINGS_CHANGED_ELSEWHERE);

      const before = new Map(current.settings.map((s) => [s.key, s.value]));
      const changes = (Object.entries(input.values) as [SettingKey, number][]).filter(
        ([key, value]) => before.get(key) !== value,
      );

      for (const [key, value] of changes) {
        await trx
          .insertInto('settings')
          .values({ key, value: JSON.stringify(value), updated_by: actor.id })
          .onConflict((oc) =>
            oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_by: actor.id }),
          )
          .execute();
        await this.audit.record(
          {
            action: 'settings.changed',
            admin_id: actor.id,
            session_id: actor.sessionId,
            target_type: 'setting',
            target_id: key,
            reason: input.reason,
            details: JSON.stringify({ setting: key, before: before.get(key), after: value }),
          },
          meta,
          trx,
        );
      }
      return { changed: changes.length, view: await this.view(trx) };
    });
  }
}
