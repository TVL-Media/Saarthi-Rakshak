import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import {
  ConsentRequest,
  DevLoginRequest,
  LoginRequest,
  type LoginReply,
  type Me,
} from '@sarthi/shared';
import { parseAppBody, type AppRequest } from '../common/app-http';
import { AppRateLimiter } from '../common/rate-limit';
import { AppPublic, NoConsentNeeded } from './app-auth.decorators';
import { ProfileService } from '../profile/profile.service';
import { AppAuthService } from './app-auth.service';
import { UserSessionsService } from './user-sessions.service';

/** Login attempts per IP address in 15 minutes. */
export const LOGIN_LIMIT_PER_IP = 10;

@Controller('v1')
export class AppAuthController {
  constructor(
    private readonly auth: AppAuthService,
    private readonly profile: ProfileService,
    private readonly sessions: UserSessionsService,
    private readonly rateLimiter: AppRateLimiter,
  ) {}

  @AppPublic()
  @Post('auth/firebase')
  @HttpCode(200)
  async login(@Req() req: AppRequest, @Body() body: unknown): Promise<LoginReply> {
    await this.rateLimiter.check(`login:${req.ip ?? 'unknown'}`, LOGIN_LIMIT_PER_IP, 15 * 60);
    const { firebaseIdToken } = parseAppBody(LoginRequest, body);
    return this.auth.login(firebaseIdToken);
  }

  /** Development only (see AppAuthService.devLogin). */
  @AppPublic()
  @Post('auth/dev-login')
  @HttpCode(200)
  async devLogin(@Req() req: AppRequest, @Body() body: unknown): Promise<LoginReply> {
    await this.rateLimiter.check(`login:${req.ip ?? 'unknown'}`, LOGIN_LIMIT_PER_IP, 15 * 60);
    const { phone, code } = parseAppBody(DevLoginRequest, body);
    return this.auth.devLogin(phone, code);
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
    return this.profile.me(req.user!.id);
  }

  @NoConsentNeeded()
  @Post('me/consent')
  @HttpCode(200)
  consent(@Req() req: AppRequest, @Body() body: unknown): Promise<Me> {
    const { version } = parseAppBody(ConsentRequest, body);
    return this.profile.giveConsent(req.user!.id, version);
  }
}
