import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorCode } from '@sarthi/shared';
import type { z } from 'zod';
import { requestPath, type HttpRequest } from '../../common/http';

// Shared helpers for the user app (/app) and guardian (/g) routes.

/** A logged-in app user, set on the request by AppAuthGuard. */
export interface AuthedUser {
  id: string;
  sessionId: string;
  consentGiven: boolean;
}

export interface AppRequest extends HttpRequest {
  user?: AuthedUser;
}

/** /v1/... (user app) and /g/... (guardian pages). */
export function isAppPath(req: HttpRequest): boolean {
  const path = requestPath(req);
  return path === '/v1' || path.startsWith('/v1/') || path === '/g' || path.startsWith('/g/');
}

/** An error the app understands: `{ error: code, message }` (see docs/app-api.md). */
export class AppError extends HttpException {
  constructor(status: HttpStatus, code: ErrorCode, message: string) {
    super({ error: code, message }, status);
  }
}

export const appError = {
  invalidInput: (message: string) => new AppError(HttpStatus.BAD_REQUEST, 'invalid_input', message),
  notLoggedIn: () => new AppError(HttpStatus.UNAUTHORIZED, 'not_logged_in', 'Please log in again.'),
  consentRequired: () =>
    new AppError(
      HttpStatus.FORBIDDEN,
      'consent_required',
      'Please accept the terms and privacy policy to continue.',
    ),
  notFound: (message = 'Not found.') => new AppError(HttpStatus.NOT_FOUND, 'not_found', message),
  conflict: (message: string) => new AppError(HttpStatus.CONFLICT, 'conflict', message),
  limitReached: (message: string) => new AppError(HttpStatus.CONFLICT, 'limit_reached', message),
  tooManyRequests: () =>
    new AppError(
      HttpStatus.TOO_MANY_REQUESTS,
      'too_many_requests',
      'Too many tries. Please wait a few minutes and try again.',
    ),
  linkExpired: (message: string) => new AppError(HttpStatus.GONE, 'link_expired', message),
  serviceUnavailable: (message: string) =>
    new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'service_unavailable', message),
};

/** Checks a request body against the shared contract; the first problem becomes `invalid_input`. */
export function parseAppBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.join('.');
    throw appError.invalidInput(field ? `${field}: ${issue.message}` : issue.message);
  }
  return result.data;
}
