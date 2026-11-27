import { Body, Controller, Delete, HttpCode, Injectable, Post, Req } from '@nestjs/common';
import { RakshakPresenceRequest, type RakshakPresence } from '@sarthi/shared';
import { sql } from 'kysely';
import { DatabaseService } from '../../database/database.module';
import { AppSettings } from '../common/app-settings';
import { appError, parseAppBody, type AppRequest } from '../common/app-http';
import { AppRateLimiter } from '../common/rate-limit';

/** Positions older than this are deleted by the hourly cleanup (no location history is kept). */
export const PRESENCE_KEEP_HOURS = 24;

/**
 * "Available now" for approved Rakshaks: while the switch is on, their phone sends its position
 * every few minutes and they appear in "Rakshaks Near Me" (first name and a rounded position only).
 * One row per Rakshak, overwritten: only the latest position exists. The session ends on its own
 * after `rakshak.available_hours`, even if the phone never says "off".
 */
@Injectable()
export class RakshakPresenceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly settings: AppSettings,
    private readonly rateLimiter: AppRateLimiter,
  ) {}

  async update(userId: string, input: RakshakPresenceRequest): Promise<RakshakPresence> {
    if ((await this.settings.get('feature.nearby')) < 1)
      throw appError.notFound('Not available yet.');
    // Every 3 minutes is expected; this leaves room for retries after a bad connection.
    await this.rateLimiter.check(`rakshak-presence:${userId}`, 60, 3600);
    const approved = await this.database.db
      .selectFrom('rakshak_applications as a')
      .innerJoin('users as u', 'u.id', 'a.user_id')
      .select('a.user_id')
      .where('a.user_id', '=', userId)
      .where('a.status', '=', 'approved')
      .where('u.status', '=', 'active')
      .executeTakeFirst();
    if (!approved) throw appError.conflict('Only approved Rakshaks can be available.');

    const hours = await this.settings.get('rakshak.available_hours');
    const now = new Date();
    const current = await this.database.db
      .selectFrom('rakshak_presence')
      .select(['online', 'available_since'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    const since =
      input.start || !current?.online || !current.available_since
        ? now
        : new Date(current.available_since);
    const until = new Date(since.getTime() + hours * 3_600_000);
    if (until <= now) {
      await this.off(userId);
      throw appError.conflict('Available now has ended. Switch it on again to be seen.');
    }

    const location = sql<string>`ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326)::geography`;
    const values = {
      location,
      accuracy_m: input.accuracyM ?? null,
      online: true,
      available_since: since,
      updated_at: now,
    };
    await this.database.db
      .insertInto('rakshak_presence')
      .values({ user_id: userId, ...values })
      .onConflict((oc) => oc.column('user_id').doUpdateSet(values))
      .execute();
    return { availableUntil: until.toISOString() };
  }

  /** "Off": the Rakshak disappears at once and the position is deleted. */
  async off(userId: string): Promise<void> {
    await this.database.db.deleteFrom('rakshak_presence').where('user_id', '=', userId).execute();
  }
}

@Controller('v1/rakshak')
export class RakshakPresenceController {
  constructor(private readonly presence: RakshakPresenceService) {}

  @Post('presence')
  @HttpCode(200)
  update(@Req() req: AppRequest, @Body() body: unknown): Promise<RakshakPresence> {
    return this.presence.update(req.user!.id, parseAppBody(RakshakPresenceRequest, body));
  }

  @Delete('presence')
  @HttpCode(204)
  async off(@Req() req: AppRequest): Promise<void> {
    await this.presence.off(req.user!.id);
  }
}
