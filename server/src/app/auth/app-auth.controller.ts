import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ConsentRequest, LoginRequest, type LoginReply, type Me } from '@sarthi/shared';
import { parseAppBody, type AppRequest } from '../common/app-http';
import { AppRateLimiter } from '../common/rate-limit';
import { AppPublic, NoConsentNeeded } from './app-auth.decorators';
import { AppAuthService } from './app-auth.service';
import { UserSessionsService } from './user-sessions.service';

/** Login attempts per IP address in 15 minutes. */
export const LOGIN_LIMIT_PER_IP = 10;

@Controller('app')
export class AppAuthController {
  constructor(
    private readonly auth: AppAuthService,
    private readonly sessions: UserSessionsService,
    private readonly rateLimiter: AppRateLimiter,
  ) {}

  @AppPublic()
  @Post('auth/login')
  @HttpCode(200)
  async login(@Req() req: AppRequest, @Body() body: unknown): Promise<LoginReply> {
    await this.rateLimiter.check(`login:${req.ip ?? 'unknown'}`, LOGIN_LIMIT_PER_IP, 15 * 60);
    const { firebaseIdToken } = parseAppBody(LoginRequest, body);
    return this.auth.login(firebaseIdToken);
  }

  @NoConsentNeeded()
  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Req() req: AppRequest): Promise<void> {
    await this.sessions.end(req.user!.sessionId, 'logout');
  }

  @NoConsentNeeded()
  @Get('me')
  me(@Req() req: AppRequest): Promise<Me> {
    return this.auth.me(req.user!.id);
  }

  @NoConsentNeeded()
  @Post('me/consent')
  @HttpCode(200)
  consent(@Req() req: AppRequest, @Body() body: unknown): Promise<Me> {
    const { version } = parseAppBody(ConsentRequest, body);
    return this.auth.giveConsent(req.user!.id, version);
  }
}
