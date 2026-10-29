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
}
