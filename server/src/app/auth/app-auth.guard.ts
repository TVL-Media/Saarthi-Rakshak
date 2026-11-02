import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { header } from '../../common/http';
import { appError, isAppPath, type AppRequest } from '../common/app-http';
import { APP_NO_CONSENT, APP_PUBLIC } from './app-auth.decorators';
import { UserSessionsService } from './user-sessions.service';

/**
 * Every /v1 and /g route needs an app login unless marked @AppPublic (default deny).
 * Until the user accepts the terms, only routes marked @NoConsentNeeded work.
 */
@Injectable()
export class AppAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: UserSessionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>();
    if (!isAppPath(req)) return true;

    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(APP_PUBLIC, targets)) return true;

    const match = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(header(req, 'authorization') ?? '');
    if (!match) throw appError.notLoggedIn();
    const user = await this.sessions.authenticate(match[1]);
    if (!user) throw appError.notLoggedIn();

    if (!user.consentGiven && !this.reflector.getAllAndOverride<boolean>(APP_NO_CONSENT, targets)) {
      throw appError.consentRequired();
    }
    req.user = user;
    return true;
  }
}
