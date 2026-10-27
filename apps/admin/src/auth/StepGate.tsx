import { useRef, type ReactNode } from 'react';
import { Navigate } from 'react-router';
import { ApiError, STEP_ROUTE, type LoginStep } from '../api';
import { useMe, type LoginPageState } from './session';

/**
 * Shows a login step only when the server says it is the current one. Otherwise sends the
 * admin to the right step, to /login, or (already logged in) to the Dashboard.
 * `hold` keeps the page open (backup codes are on screen after 2-step is turned on).
 */
export function StepGate({
  step,
  hold,
  children,
}: {
  step: LoginStep;
  hold?: boolean;
  children: ReactNode;
}) {
  const me = useMe();
  // Set once the server has said this step is the current one.
  const shown = useRef(false);
  if (hold) return children;
  // A half-finished login has no data, so each background check counts as "loading" again.
  // Keep the step on screen meanwhile; unmounting it would lose what was typed (and ask for
  // a new 2-step secret).
  if (me.isPending) return shown.current ? children : null;
  shown.current = false;
  if (me.isSuccess) return <Navigate to="/" replace />;

  const error = me.error;
  if (error instanceof ApiError && error.sessionReason === 'login_incomplete' && error.body.next) {
    if (error.body.next === step) {
      shown.current = true;
      return children;
    }
    return <Navigate to={STEP_ROUTE[error.body.next]} replace />;
  }
  const reason = error instanceof ApiError ? error.sessionReason : undefined;
  const state: LoginPageState = { reason: reason === 'no_session' ? undefined : reason };
  return <Navigate to="/login" replace state={state} />;
}
