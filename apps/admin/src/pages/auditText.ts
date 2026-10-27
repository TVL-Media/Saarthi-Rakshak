import { FIELDS } from './SettingsPage';

/** One audit entry as the server sends it. */
export interface AuditEntry {
  id: string;
  at: string;
  kind: 'view' | 'change' | 'login';
  action: string;
  admin: { id: string; name: string } | null;
  targetType: string | null;
  targetId: string | null;
  targetName: string | null;
  reason: string | null;
  details: unknown;
  ip: string | null;
  userAgent: string | null;
  statusCode: number | null;
}

/** The tag: Viewed / Changed / Login (never "Logged in": a failed login is not a login). */
export const KIND_TAG: Record<AuditEntry['kind'], string> = {
  view: 'Viewed',
  change: 'Changed',
  login: 'Login',
};

/** Shown in the Admin column. */
export function adminLabel(entry: AuditEntry): string {
  if (entry.admin) return entry.admin.name;
  if (entry.action.startsWith('setup.')) return 'System (server command)';
  // A login with an email that matches no admin. The typed text is never stored.
  return 'Unknown email';
}

/** Red flag next to the tag. */
export function flagOf(entry: AuditEntry): 'Failed' | 'Refused' | null {
  if (entry.action === 'auth.access_denied') return 'Refused';
  if (
    [
      'auth.login_failed',
      'auth.2fa_failed',
      'auth.account_locked',
      'auth.password_change_failed',
    ].includes(entry.action)
  ) {
    return 'Failed';
  }
  return null;
}

const PAGES: Record<string, string> = {
  '/admin/settings': 'Settings',
  '/admin/admins': 'Admin Team',
  '/admin/audit': 'Audit Log',
};

function pageName(route: string): string {
  return PAGES[route] ?? route;
}

const LOGIN_METHOD: Record<string, string> = {
  'password only (2-step login is off)': 'password only',
  authenticator: 'with 2-step code',
  'authenticator (first setup)': 'with 2-step code (first setup)',
  'backup code': 'with a backup code',
};

const SESSION_END: Record<string, string> = {
  idle: 'Logged out after 30 minutes without activity',
  expired: 'Logged out 12 hours after login',
  'account disabled': 'Session ended (account removed)',
};

const ROLE: Record<string, string> = { super_admin: 'Super Admin', support_admin: 'Support Admin' };

/** The "What" column: the entry in plain words. Never shows passwords or typed emails. */
export function describe(entry: AuditEntry): string {
  const name = entry.targetName ?? 'an admin';
  const details = (entry.details ?? {}) as Record<string, unknown>;

  if (entry.action.startsWith('GET ')) return `${pageName(entry.action.slice(4))} page`;
  switch (entry.action) {
    case 'auth.access_denied':
      return `Tried to open ${pageName((entry.reason ?? '').replace(/^GET /, ''))} (not allowed)`;
    case 'auth.password_accepted':
      return 'Password correct, next step';
    case 'auth.login_succeeded':
      return `Logged in · ${LOGIN_METHOD[entry.reason ?? ''] ?? entry.reason ?? ''}`.trim();
    case 'auth.login_failed':
      return `Login failed · ${entry.reason ?? ''}`;
    case 'auth.2fa_failed':
      return 'Wrong 2-step code';
    case 'auth.account_locked':
      return 'Account locked for 15 minutes after 5 wrong tries';
    case 'auth.logout':
      return 'Logged out';
    case 'auth.session_expired':
      return SESSION_END[entry.reason ?? ''] ?? 'Session ended';
    case 'auth.2fa_setup_started':
      return 'Started 2-step setup';
    case 'auth.2fa_enabled':
      return 'Turned on 2-step login';
    case 'auth.backup_code_used':
      return 'Used a backup code';
    case 'auth.backup_codes_regenerated':
      return 'Made new backup codes';
    case 'auth.password_changed':
      return 'Changed own password';
    case 'auth.password_change_failed':
      return 'Wrong current password';
    case 'settings.changed': {
      const field = FIELDS.find((f) => f.key === details.setting);
      const label = field?.label ?? String(details.setting);
      const unit = field ? ` ${field.unit}` : '';
      return `Settings · ${label} (${String(details.before)} → ${String(details.after)}${unit})`;
    }
    case 'admin.created':
      return `Admin Team · added ${name} (${ROLE[String(details.role)] ?? 'admin'})`;
    case 'admin.removed':
      return `Admin Team · removed ${name}`;
    case 'admin.password_reset':
      return `Admin Team · reset password for ${name}`;
    case 'admin.2fa_reset':
      return `Admin Team · reset 2-step login for ${name}`;
    case 'setup.settings_added':
      return 'Setup · default safety settings added';
    case 'setup.super_admin_created':
      return `Setup · first Super Admin created (${name})`;
    case 'setup.super_admin_reissued':
      return `Setup · new temporary password for ${name}`;
    default:
      return entry.action;
  }
}
