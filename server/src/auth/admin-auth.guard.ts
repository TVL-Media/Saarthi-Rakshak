import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditService } from '../audit/audit.service';
import { header, isAdminPath, requestMeta, requestPath, type HttpRequest } from '../common/http';
import type { SessionStage } from '../database/types';
import { SESSION_COOKIE } from './auth.constants';
import { ALLOWED_STAGES, IS_PUBLIC, ROLES } from './auth.decorators';
import { readCookie } from './cookies';
import { SessionsService } from './sessions.service';

/**
 * Every /admin route needs a finished login unless marked @Public or @AllowStages
 * (default deny), and roles from @Roles are checked here, on the server.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<HttpRequest>();
    if (!isAdminPath(req)) return true;

    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const token = readCookie(header(req, 'cookie'), SESSION_COOKIE);
    if (!token) throw new UnauthorizedException('Not logged in, or the session has ended');
    const admin = await this.sessions.authenticate(token, requestMeta(req));

    const stages = this.reflector.getAllAndOverride<SessionStage[]>(ALLOWED_STAGES, targets) ?? [
      'full',
    ];
    if (!stages.includes(admin.stage)) {
      throw new UnauthorizedException('Finish logging in first');
    }

    const roles = this.reflector.getAllAndOverride<string[]>(ROLES, targets);
    if (roles && !roles.includes(admin.role)) {
      await this.audit.record(
        {
          action: 'auth.access_denied',
          admin_id: admin.id,
          session_id: admin.sessionId,
          reason: `${req.method} ${req.route?.path ?? requestPath(req)}`,
          status_code: 403,
        },
        requestMeta(req),
      );
      throw new ForbiddenException('Your role does not allow this');
    }

    req.admin = admin;
    return true;
  }
}
