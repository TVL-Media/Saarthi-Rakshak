import { Injectable } from '@nestjs/common';
import { sql, type ExpressionBuilder } from 'kysely';
import { DatabaseService } from '../database/database.module';
import type { Database } from '../database/types';

export const AUDIT_PAGE_SIZE = 50;

/** How the Audit Log groups entries: tags Viewed / Changed / Login. */
export type AuditKind = 'view' | 'change' | 'login';

/** Login-related events (tag "Login"). */
const LOGIN_ACTIONS = [
  'auth.password_accepted',
  'auth.login_succeeded',
  'auth.login_failed',
  'auth.account_locked',
  'auth.logout',
  'auth.session_expired',
  'auth.2fa_setup_started',
  'auth.2fa_failed',
  'auth.backup_code_used',
];

export function kindOf(action: string): AuditKind {
  if (
    action.startsWith('GET ') ||
    [
      'auth.access_denied',
      'users.searched',
      'dashboard.viewed',
      'live.viewed',
      'live_sos.viewed',
    ].includes(action)
  ) {
    return 'view';
  }
  if (LOGIN_ACTIONS.includes(action)) return 'login';
  return 'change';
}

export interface AuditQuery {
  adminId?: string;
  /** all = "Views and changes" (everything). */
  kind: 'all' | 'changes' | 'logins';
  /** India dates (YYYY-MM-DD), both included. */
  from?: string;
  to?: string;
  /** Continue after this entry id ("Load more"). */
  before?: string;
}

export interface AuditEntry {
  id: string;
  at: Date;
  kind: AuditKind;
  action: string;
  admin: { id: string; name: string } | null;
  targetType: string | null;
  targetId: string | null;
  /** Name of the admin the action was about (Admin Team, setup). */
  targetName: string | null;
  reason: string | null;
  details: unknown;
  ip: string | null;
  userAgent: string | null;
  statusCode: number | null;
}

@Injectable()
export class AuditLogService {
  constructor(private readonly database: DatabaseService) {}

  /** Newest first, 50 per page. Read-only: the log itself can never be changed. */
  async list(query: AuditQuery): Promise<{ entries: AuditEntry[]; more: boolean }> {
    let q = this.database.db
      .selectFrom('audit_log as l')
      .leftJoin('admins as a', 'a.id', 'l.admin_id')
      .leftJoin('admins as t', (join) =>
        join.onRef(sql`t.id::text`, '=', 'l.target_id').on('l.target_type', '=', 'admin'),
      )
      .select([
        'l.id',
        'l.created_at',
        'l.action',
        'l.admin_id',
        'a.name as admin_name',
        'l.target_type',
        'l.target_id',
        't.name as target_name',
        'l.reason',
        'l.details',
        sql<string | null>`host(l.ip)`.as('ip'),
        'l.user_agent',
        'l.status_code',
      ])
      .orderBy('l.id', 'desc')
      .limit(AUDIT_PAGE_SIZE + 1);

    if (query.adminId) q = q.where('l.admin_id', '=', query.adminId);
    if (query.before) q = q.where('l.id', '<', query.before);
    if (query.from) {
      q = q.where(
        'l.created_at',
        '>=',
        sql<Date>`(${query.from}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'`,
      );
    }
    if (query.to) {
      q = q.where(
        'l.created_at',
        '<',
        sql<Date>`((${query.to}::date) + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'`,
      );
    }
    if (query.kind === 'logins') q = q.where('l.action', 'in', LOGIN_ACTIONS);
    if (query.kind === 'changes') {
      q = q.where((eb: ExpressionBuilder<Database & { l: Database['audit_log'] }, 'l'>) =>
        eb.and([
          eb('l.action', 'not in', LOGIN_ACTIONS),
          eb('l.action', 'not like', 'GET %'),
          eb('l.action', '!=', 'auth.access_denied'),
          eb('l.action', '!=', 'users.searched'),
          eb('l.action', '!=', 'dashboard.viewed'),
          eb('l.action', '!=', 'live.viewed'),
          eb('l.action', '!=', 'live_sos.viewed'),
        ]),
      );
    }

    const rows = await q.execute();
    const more = rows.length > AUDIT_PAGE_SIZE;
    return {
      more,
      entries: rows.slice(0, AUDIT_PAGE_SIZE).map((r) => ({
        id: String(r.id),
        at: r.created_at,
        kind: kindOf(r.action),
        action: r.action,
        admin: r.admin_id ? { id: r.admin_id, name: r.admin_name ?? '' } : null,
        targetType: r.target_type,
        targetId: r.target_id,
        targetName: r.target_name,
        reason: r.reason,
        details: r.details,
        ip: r.ip,
        userAgent: r.user_agent,
        statusCode: r.status_code,
      })),
    };
  }
}
