import { Injectable } from '@nestjs/common';
import type { SupportRequest } from '@sarthi/shared';
import { DatabaseService } from '../../database/database.module';
import { AppRateLimiter } from '../common/rate-limit';

/** "Report a problem" messages per user per day. */
export const SUPPORT_TICKETS_PER_DAY = 5;

/** "Report a problem": a support ticket for the admin panel's Support Tickets screen. */
@Injectable()
export class SupportService {
  constructor(
    private readonly database: DatabaseService,
    private readonly rateLimiter: AppRateLimiter,
  ) {}

  async create(userId: string, input: SupportRequest): Promise<void> {
    await this.rateLimiter.check(`support:${userId}`, SUPPORT_TICKETS_PER_DAY, 24 * 3600);

    // App version and phone model: from the request, or else the phone's last device details.
    const device = await this.database.db
      .selectFrom('devices')
      .select(['app_version', 'model'])
      .where('user_id', '=', userId)
      .orderBy('updated_at', 'desc')
      .limit(1)
      .executeTakeFirst();

    await this.database.db
      .insertInto('support_tickets')
      .values({
        user_id: userId,
        category: input.category,
        message: input.message,
        app_version: input.appVersion ?? device?.app_version?.slice(0, 40) ?? null,
        device_model: input.deviceModel ?? device?.model?.slice(0, 80) ?? null,
      })
      .execute();
  }
}
