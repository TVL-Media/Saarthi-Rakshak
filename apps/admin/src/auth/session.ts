import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Me, type SessionEndReason } from '../api';

export const ME_KEY = ['me'] as const;

/**
 * Who is logged in. Checked again every minute so an ended session sends the admin to
 * /login; the server does not count this check as activity (it never prevents auto logout).
 */
export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: () => api<Me>('/admin/auth/me'),
    retry: false,
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
  });
}

/** Forget what we knew about the session (after login steps or logout). */
export function useResetSession() {
  const queryClient = useQueryClient();
  return () => queryClient.removeQueries({ queryKey: ME_KEY });
}

/** Passed to /login in router state (memory only, never stored). */
export interface LoginPageState {
  reason?: SessionEndReason;
}

/** Text from the design's "Logged out" note. */
export const LOGGED_OUT_MESSAGE: Partial<Record<SessionEndReason, string>> = {
  idle: 'You were logged out after 30 minutes without activity. Log in again to continue.',
  expired: 'You were logged out 12 hours after login. Log in again to continue.',
  ended: 'Your session ended. Log in again.',
};
