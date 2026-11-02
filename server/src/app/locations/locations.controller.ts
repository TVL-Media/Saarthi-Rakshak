import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { HeartbeatRequest, LocationsRequest, type LocationsReply } from '@sarthi/shared';
import { DatabaseService } from '../../database/database.module';
import { parseAppBody, type AppRequest } from '../common/app-http';
import { AppRateLimiter } from '../common/rate-limit';
import { LocationsService } from './locations.service';

/** Location batches per user per minute (normal use is about 12–20). */
export const LOCATION_CALLS_PER_MINUTE = 120;

@Controller('v1')
export class LocationsController {
  constructor(
    private readonly locations: LocationsService,
    private readonly rateLimiter: AppRateLimiter,
    private readonly database: DatabaseService,
  ) {}

  @Post('locations')
  @HttpCode(200)
  async save(@Req() req: AppRequest, @Body() body: unknown): Promise<LocationsReply> {
    const { points } = parseAppBody(LocationsRequest, body);
    await this.rateLimiter.check(`locations:${req.user!.id}`, LOCATION_CALLS_PER_MINUTE, 60);
    return this.locations.save(req.user!.id, points);
  }

  @Post('heartbeat')
  @HttpCode(204)
  async heartbeat(@Req() req: AppRequest, @Body() body: unknown): Promise<void> {
    const beat = parseAppBody(HeartbeatRequest, body);
    const session = await this.database.db
      .selectFrom('user_sessions')
      .select('device_id')
      .where('id', '=', req.user!.sessionId)
      .executeTakeFirst();
    await this.locations.heartbeat(req.user!.id, session?.device_id ?? null, beat);
  }
}
