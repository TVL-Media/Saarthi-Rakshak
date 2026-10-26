import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';
import type { SessionStage } from '../database/types';

// Minimal request/response shapes we use (Express underneath), so no extra type packages.

export interface AuthedAdmin {
  id: string;
  role: 'super_admin' | 'support_admin';
  name: string;
  email: string;
  sessionId: string;
  stage: SessionStage;
}

export interface HttpRequest {
  method: string;
  originalUrl: string;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  params: Record<string, string | undefined>;
  route?: { path: string };
  /** Set by AdminAuthGuard once the session is checked. */
  admin?: AuthedAdmin;
}

export interface HttpResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export function requestMeta(req: HttpRequest): RequestMeta {
  const ua = req.headers['user-agent'];
  return { ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua.slice(0, 500) : null };
}

export function header(req: HttpRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The URL path without the query string. */
export function requestPath(req: HttpRequest): string {
  return req.originalUrl.split('?')[0];
}

export function isAdminPath(req: HttpRequest): boolean {
  const path = requestPath(req);
  return path === '/admin' || path.startsWith('/admin/');
}

/** Validates a request body; the first problem becomes a 400 with a readable message. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.join('.');
    throw new BadRequestException(field ? `${field}: ${issue.message}` : issue.message);
  }
  return result.data;
}
