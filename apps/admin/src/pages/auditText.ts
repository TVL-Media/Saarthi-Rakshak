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
  '/admin/users/:id/phase2': "User's Phase 2 details (evidence list only, never its content)",
  '/admin/community/posts': 'Community reports',
  '/admin/rakshak/applications': 'Rakshak applications',
  '/admin/rakshak/applications/:id': 'Rakshak application',
  '/admin/plans': 'Plans',
  '/admin/subscriptions': 'Subscriptions',
  '/admin/phase2/stats': 'Phase 2 counts (Reports)',
  '/admin/bookings': 'Bookings',
  '/admin/bookings/rakshaks': 'Approved Rakshaks (for a booking)',
  '/admin/bookings/:id': 'Booking',
  '/admin/support-tickets': 'Support Tickets',
  '/admin/support-tickets/:id': 'Support ticket',
  '/admin/phase4/overview': 'Safety Services counts',
  '/admin/phase4/partners': 'Safety Services partners',
  '/admin/phase4/partners/:id': 'Safety Services partner',
  '/admin/phase4/requests': 'Support and legal requests',
  '/admin/phase4/requests/:id': 'Support or legal request',
  '/admin/phase4/guidance': 'Guidance texts',
  '/admin/phase4b/monitoring': 'Chhupa Rakshak sessions (metadata only)',
  '/admin/phase4b/cyber': 'Cyberbullying counts',
  '/admin/phase4b/schools': 'Schools',
  '/admin/phase4b/school-links': 'School link requests',
  '/admin/phase4b/school-quarantine': 'Rejected school events',
  '/admin/phase4b/glasses-models': 'Smart glasses models',
  '/admin/phase4b/safety/datasets': 'Safety datasets',
  '/admin/phase4b/safety/models': 'Safety scoring models',
  '/admin/phase4b/safety/feedback': 'Route feedback',
  '/admin/phase4b/authority/endpoints': 'Authority endpoints',
  '/admin/phase4b/authority/attempts': 'Police handoff attempts',
  '/admin/phase4b/authority/queries': 'Verification queries',
};

const BOOKING_ACTIONS: Record<string, string> = {
  'POST /admin/bookings/:id/quote': 'Bookings · sent a quote',
  'POST /admin/bookings/:id/assign': 'Bookings · assigned a Rakshak',
  'POST /admin/bookings/:id/status': 'Bookings · changed the progress of a booking',
  'POST /admin/bookings/:id/cancel': 'Bookings · cancelled a booking',
  'POST /admin/support-tickets/:id/assign': 'Support Tickets · assigned or unassigned a ticket',
  'POST /admin/support-tickets/:id/status': 'Support Tickets · changed the status of a ticket',
  'POST /admin/phase4/partners': 'Safety Services · added a partner',
  'POST /admin/phase4/partners/:id': 'Safety Services · edited a partner',
  'POST /admin/phase4/partners/:id/action':
    'Safety Services · verified, approved, rejected or expired a partner',
  'POST /admin/phase4/requests/:id/status': 'Safety Services · moved a request on',
  'POST /admin/phase4/guidance': 'Safety Services · added guidance',
  'POST /admin/phase4/guidance/:id': 'Safety Services · edited guidance',
  'POST /admin/phase4/guidance/:id/approve': 'Safety Services · approved guidance',
  'POST /admin/phase4/guidance/:id/retire': 'Safety Services · retired guidance',
  'POST /admin/phase4b/schools': 'Safety Integrations · added a school',
  'POST /admin/phase4b/schools/:id/status': 'Safety Integrations · changed a school status',
  'POST /admin/phase4b/schools/:id/rotate-key': 'Safety Integrations · rotated a school key',
  'POST /admin/phase4b/school-links/:id/decision': 'Safety Integrations · decided a school link',
  'POST /admin/phase4b/glasses-models': 'Safety Integrations · added a glasses model',
  'PUT /admin/phase4b/glasses-models/:id': 'Safety Integrations · edited a glasses model',
  'POST /admin/phase4b/safety/datasets': 'Safety Integrations · added a safety dataset',
  'POST /admin/phase4b/safety/datasets/:id/status': 'Safety Integrations · changed a dataset status',
  'POST /admin/phase4b/safety/datasets/:id/import': 'Safety Integrations · imported dataset records',
  'POST /admin/phase4b/safety/models': 'Safety Integrations · added a scoring model',
  'POST /admin/phase4b/safety/models/:id/activate': 'Safety Integrations · activated a scoring model',
  'POST /admin/phase4b/safety/feedback/:id/review': 'Safety Integrations · reviewed route feedback',
  'POST /admin/phase4b/authority/endpoints': 'Police handoff · added an endpoint',
  'POST /admin/phase4b/authority/endpoints/:id/enabled': 'Police handoff · switched an endpoint on or off',
  'POST /admin/phase4b/authority/endpoints/:id/sandbox-passed': 'Police handoff · marked sandbox tests passed',
  'POST /admin/phase4b/authority/endpoints/:id/health': 'Police handoff · checked endpoint health',
  'POST /admin/phase4b/authority/endpoints/:id/verify': 'Police handoff · ran a verification query',
  'POST /admin/phase4b/authority/attempts/:id/fallback': 'Police handoff · recorded the manual fallback',
  'POST /admin/phase4b/authority/attempts/:id/acknowledged': 'Police handoff · recorded the authority confirmation',
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
  if (BOOKING_ACTIONS[entry.action]) return BOOKING_ACTIONS[entry.action];
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
    case 'admin.restored':
      return `Admin Team · restored ${name} (${ROLE[String(details.role)] ?? 'admin'})`;
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
    case 'setup.temp_password_applied':
      return `Setup · temporary password from the server settings for ${name} (test server)`;
    default:
      return entry.action;
  }
}
