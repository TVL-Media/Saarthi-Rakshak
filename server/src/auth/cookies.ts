import { SESSION_COOKIE } from './auth.constants';

/** Reads one cookie from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/**
 * The session cookie: HttpOnly (no JavaScript access), Secure (HTTPS only; browsers allow it on
 * localhost), SameSite=Strict (never sent from other sites). __Host- forbids a Domain attribute.
 */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function clearedSessionCookie(): string {
  return sessionCookie('', 0);
}
