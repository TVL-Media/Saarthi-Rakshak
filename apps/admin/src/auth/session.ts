import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Me, type SessionEndReason } from '../api';

export const ME_KEY = ['me'] as const;
export const TWO_STEP_SETUP_KEY = ['two-step-setup'] as const;

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

/** Server login options: whether 2-step login is on (ADMIN_TWO_STEP). */
export function useAuthOptions() {
  return useQuery({
    queryKey: ['auth-options'],
    queryFn: () => api<{ twoStep: boolean }>('/admin/auth/options'),
    staleTime: Infinity,
  });
}

/**
 * Forget what we knew about the session (after login steps or logout), including any 2-step
 * setup secret, so the next person in this browser never sees it.
 */
export function useResetSession() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.removeQueries({ queryKey: ME_KEY });
    queryClient.removeQueries({ queryKey: TWO_STEP_SETUP_KEY });
  };
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
