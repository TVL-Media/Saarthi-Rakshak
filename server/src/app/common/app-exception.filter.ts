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
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ error: 'server_error', message: 'Something went wrong. Please try again.' });
  }
}
