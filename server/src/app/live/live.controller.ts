import { Controller, Get, Header, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { LiveView } from '@sarthi/shared';
import { AppPublic } from '../auth/app-auth.decorators';
import type { AppRequest } from '../common/app-http';
import { AppRateLimiter } from '../common/rate-limit';
import { LiveService } from './live.service';

/** Page loads per IP per minute (the page also reloads itself every minute). */
export const LIVE_VIEWS_PER_MINUTE = 120;

/** The guardian's live page (from the SMS link). No login: the link code is the key. */
@Controller('g/l')
export class LiveController {
  constructor(
    private readonly live: LiveService,
    private readonly rateLimiter: AppRateLimiter,
  ) {}

  @AppPublic()
  @Get(':code')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @Header('Cache-Control', 'no-store')
  async view(@Req() req: AppRequest, @Param('code') code: string): Promise<LiveView> {
    await this.rateLimiter.check(`live:${req.ip ?? 'unknown'}`, LIVE_VIEWS_PER_MINUTE, 60);
    return this.live.view(code);
  }

  @AppPublic()
  @Post(':code/responding')
  @HttpCode(200)
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @Header('Cache-Control', 'no-store')
  async responding(@Req() req: AppRequest, @Param('code') code: string): Promise<LiveView> {
    await this.rateLimiter.check(`live:${req.ip ?? 'unknown'}`, LIVE_VIEWS_PER_MINUTE, 60);
    return this.live.responding(code);
  }
}
