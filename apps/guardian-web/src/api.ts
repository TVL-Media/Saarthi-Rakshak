import type { ErrorReply, InviteInfo, LiveView } from '@sarthi/shared';

/** A failed call, with the server's `{ error, message }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const OFFLINE = 'No internet connection. Check your connection and try again.';

async function call<T>(method: 'GET' | 'POST', path: string): Promise<T> {
  let res: Response;
  try {
    // Same site as the page: /g/... is served (or proxied in development) next to it.
    res = await fetch(path, { method, headers: { Accept: 'application/json' }, cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'offline', OFFLINE);
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = body as Partial<ErrorReply> | null;
    throw new ApiError(
      res.status,
      err?.error ?? 'server_error',
      err?.message ?? 'Something went wrong. Please try again.',
    );
  }
  return body as T;
}

const enc = encodeURIComponent;

export const api = {
  invite: (code: string) => call<InviteInfo>('GET', `/g/i/${enc(code)}`),
  accept: (code: string) => call<void>('POST', `/g/i/${enc(code)}/accept`),
  decline: (code: string) => call<void>('POST', `/g/i/${enc(code)}/decline`),
  live: (code: string) => call<LiveView>('GET', `/g/l/${enc(code)}`),
  responding: (code: string) => call<LiveView>('POST', `/g/l/${enc(code)}/responding`),
};
