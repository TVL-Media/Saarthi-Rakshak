import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { catchError, concatMap, from, map, throwError, type Observable } from 'rxjs';
import { AUDIT_VIEW_WINDOW_SECONDS } from '../auth/auth.constants';
import { NO_AUDIT } from '../auth/auth.decorators';
import { requestMeta, requestPath, type HttpRequest } from '../common/http';
import { RedisService } from '../redis/redis.module';
import { AuditService } from './audit.service';

// NestJS's own metadata key for @HttpCode().
const HTTP_CODE_METADATA = '__httpCode__';

/**
 * Writes one audit row for every view and action by a logged-in admin. Skips routes marked
 * @NoAudit, and repeats of the same view (GET) by the same session within a short window.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<HttpRequest>();
    const targets = [context.getHandler(), context.getClass()];
    if (!req.admin || this.reflector.getAllAndOverride<boolean>(NO_AUDIT, targets)) {
      return next.handle();
    }
    const successStatus =
      this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler()) ??
      (req.method === 'POST' ? 201 : 200);

    return next.handle().pipe(
      concatMap((data: unknown) => from(this.write(req, successStatus)).pipe(map(() => data))),
      catchError((err: unknown) => {
        const status = err instanceof HttpException ? err.getStatus() : 500;
        return from(this.write(req, status)).pipe(concatMap(() => throwError(() => err)));
      }),
    );
  }

  private async write(req: HttpRequest, status: number): Promise<void> {
    const admin = req.admin!;
    if (req.method === 'GET' && (await this.isRepeatView(admin.sessionId, req.originalUrl))) return;
    await this.audit.record(
      {
        action: `${req.method} ${req.route?.path ?? requestPath(req)}`,
        admin_id: admin.id,
        session_id: admin.sessionId,
        target_type: req.params.id ? 'id' : null,
        target_id: req.params.id ?? null,
        status_code: status,
      },
      requestMeta(req),
    );
  }

  /** True if this session already viewed this exact URL within the window. */
  private async isRepeatView(sessionId: string, url: string): Promise<boolean> {
    try {
      const first = await this.redis.client.set(
        `audit:view:${sessionId}:${url}`,
        '1',
        'EX',
        AUDIT_VIEW_WINDOW_SECONDS,
        'NX',
      );
      return first === null;
    } catch (err) {
      // Redis down: write the row anyway (better a duplicate than a missing view).
      this.logger.error(`View de-duplication skipped: ${(err as Error).message}`);
      return false;
    }
  }
}
