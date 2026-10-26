import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { header, isAdminPath, type HttpRequest } from '../common/http';
import { ENV } from '../config/env.module';
import type { Env } from '../config/env.schema';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cross-site protection for /admin routes, on top of SameSite=Strict cookies: anything that
 * changes data must come from the admin panel's origin, and any body must be JSON.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(@Inject(ENV) private readonly env: Env) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HttpRequest>();
    if (!isAdminPath(req) || SAFE_METHODS.has(req.method)) return true;

    if (header(req, 'origin') !== this.env.ADMIN_PANEL_ORIGIN) {
      throw new ForbiddenException('Request origin not allowed');
    }
    const hasBody =
      Number(header(req, 'content-length') ?? 0) > 0 ||
      header(req, 'transfer-encoding') !== undefined;
    if (hasBody && !header(req, 'content-type')?.startsWith('application/json')) {
      throw new UnsupportedMediaTypeException('Send JSON');
    }
    return true;
  }
}
