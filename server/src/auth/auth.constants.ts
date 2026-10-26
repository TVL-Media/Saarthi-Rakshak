// Security limits. Fixed in code on purpose (not admin-editable); see docs/decisions.md.

export const SESSION_COOKIE = '__Host-sr_admin';

/** A half-finished login (password accepted, 2-step not yet done). */
export const PENDING_SESSION_MINUTES = 10;
/** Auto logout after this long without a request. */
export const IDLE_TIMEOUT_MINUTES = 30;
/** A full session ends at the latest this long after login. */
export const SESSION_MAX_HOURS = 12;

/** Failed passwords or 2-step codes in a row before the account is locked. */
export const LOCKOUT_FAILURES = 5;
export const LOCKOUT_MINUTES = 15;

/** Login and 2-step attempts allowed per IP address per window. */
export const IP_ATTEMPT_LIMIT = 20;
export const IP_WINDOW_MINUTES = 15;

export const BACKUP_CODE_COUNT = 10;

/** The same view by the same session is written to the audit log at most once per window. */
export const AUDIT_VIEW_WINDOW_SECONDS = 60;

/** One message for every login failure, so it never reveals whether an email exists. */
export const LOGIN_FAILED_MESSAGE = 'Login failed. Check your details or try again later.';
