import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.module';
import { DEFAULT_SETTINGS, type SettingKey } from '../../settings/default-settings';

/** Reads the safety rules a Super Admin can change in Settings (read-only for the app side). */
@Injectable()
export class AppSettings {
  constructor(private readonly database: DatabaseService) {}

  /** The saved value, or the default if it was never saved. */
  async get(key: SettingKey): Promise<number> {
    const row = await this.database.db
      .selectFrom('settings')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst();
    return typeof row?.value === 'number' ? row.value : DEFAULT_SETTINGS[key].value;
  }

  /**
   * Every rule as it is now, to copy onto a new SOS or journey. Timers read the copy, so a
   * settings change never changes an emergency that is already running.
   */
  async snapshot(): Promise<Record<SettingKey, number>> {
    const rows = await this.database.db.selectFrom('settings').select(['key', 'value']).execute();
    const saved = new Map(rows.map((r) => [r.key, r.value]));
    const rules = {} as Record<SettingKey, number>;
    for (const key of Object.keys(DEFAULT_SETTINGS) as SettingKey[]) {
      const value = saved.get(key);
      rules[key] = typeof value === 'number' ? value : DEFAULT_SETTINGS[key].value;
    }
    return rules;
  }
}
