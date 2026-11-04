import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { ErrorCode } from '@sarthi/shared';
import type { HttpRequest } from '../../common/http';
import { AppError, isAppPath } from './app-http';

interface JsonResponse {
  status(code: number): JsonResponse;
  json(body: unknown): void;
}

const CODE_FOR_STATUS: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: 'invalid_input',
  [HttpStatus.UNAUTHORIZED]: 'not_logged_in',
  [HttpStatus.NOT_FOUND]: 'not_found',
  [HttpStatus.CONFLICT]: 'conflict',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'invalid_input',
  [HttpStatus.TOO_MANY_REQUESTS]: 'too_many_requests',
};

/**
 * Every error on /app and /g routes leaves as `{ error, message }` (docs/app-api.md).
 * Other routes (/admin, /health) keep Nest's normal error replies.
 */
@Catch()
export class AppExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('AppErrors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<HttpRequest>();
    if (!isAppPath(req)) {
      super.catch(exception, host);
      return;
    }

    const res = http.getResponse<JsonResponse>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (exception instanceof AppError) {
        res.status(status).json(exception.getResponse());
        return;
      }
      const code = CODE_FOR_STATUS[status];
      if (code) {
        const message = status === 404 ? 'Not found.' : exception.message;
        res.status(status).json({ error: code, message });
        return;
      }
    }

    // Unexpected: log it on the server, never send details to the phone.
    this.logger.error(
      exception instanceof Error ? (exception.stack ?? exception.message) : exception,
    );
    if (isUnreachable(exception)) {
      // e.g. file storage not running: tell the phone it is temporary, not a broken request.
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        error: 'service_unavailable',
        message: 'A service the server needs is not reachable right now. Please try again later.',
      });
      return;
    }
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ error: 'server_error', message: 'Something went wrong. Please try again.' });
  }
}

/** Network errors from a service the server calls (file storage, database, Redis). */
const LOST_CONNECTION = [
  'Connection terminated',
  'timeout exceeded when trying to connect',
  'Connection is closed',
];
const UNREACHABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']);

export function isUnreachable(e: unknown): boolean {
  for (let cur = e, depth = 0; cur && typeof cur === 'object' && depth < 4; depth++) {
    const err = cur as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown[] };
    if (typeof err.code === 'string' && UNREACHABLE.has(err.code)) return true;
    if (err.name === 'TimeoutError' || err.name === 'MaxRetriesPerRequestError') return true;
    // node-postgres and ioredis messages for a connection that dropped or could not be made.
    const message = (cur as { message?: unknown }).message;
    if (typeof message === 'string' && LOST_CONNECTION.some((m) => message.includes(m)))
      return true;
    if (Array.isArray(err.errors) && err.errors.some((x) => isUnreachable(x))) return true;
    cur = err.cause;
  }
  return false;
}
