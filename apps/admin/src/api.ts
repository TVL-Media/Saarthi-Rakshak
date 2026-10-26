// Calls to the server. The session lives in an HttpOnly cookie the browser sends itself;
// nothing about the session is stored in the browser by this code.

export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');

/** Why the server says we are not (or no longer) logged in. */
export type SessionEndReason = 'no_session' | 'idle' | 'expired' | 'ended' | 'login_incomplete';
/** Login steps, as the server names them. */
export type LoginStep = 'change_password' | 'setup_2fa' | 'verify_2fa';

export interface ApiErrorBody {
  message?: string | string[];
  reason?: SessionEndReason;
  next?: LoginStep;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(`Request failed (${status})`);
  }

  /** A 401 that means the session is gone or unfinished (not a wrong code or password). */
  get sessionReason(): SessionEndReason | undefined {
    return this.status === 401 ? this.body.reason : undefined;
  }

  /** The server's own validation text (only used where the design says to show it). */
  get serverMessage(): string | undefined {
    const m = this.body.message;
    return Array.isArray(m) ? m[0] : m;
  }
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(API_URL + path, {
    method: init.method ?? 'GET',
    credentials: 'include',
    headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data ?? {});
  return data as T;
}

export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body });

export interface Me {
  id: string;
  name: string;
  email: string;
  role: 'super_admin' | 'support_admin';
  backupCodesLeft: number;
}

export const ROLE_LABEL: Record<Me['role'], string> = {
  super_admin: 'Super Admin',
  support_admin: 'Support Admin',
};

export const STEP_ROUTE: Record<LoginStep, string> = {
  change_password: '/change-password',
  setup_2fa: '/two-step/setup',
  verify_2fa: '/two-step',
};
