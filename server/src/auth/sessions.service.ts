import { createHash, randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import { AuditService } from '../audit/audit.service';
import type { AuthedAdmin, RequestMeta } from '../common/http';
import { DatabaseService } from '../database/database.module';
import type { Database, SessionStage } from '../database/types';
import { IDLE_TIMEOUT_MINUTES, PENDING_SESSION_MINUTES, SESSION_MAX_HOURS } from './auth.constants';

type Db = Kysely<Database> | Transaction<Database>;

export interface NewSession {
  /** Goes into the cookie only. The database keeps its SHA-256 hash. */
  token: string;
  maxAgeSeconds: number;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const notLoggedIn = () => new UnauthorizedException('Not logged in, or the session has ended');

@Injectable()
export class SessionsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async create(
    adminId: string,
    stage: SessionStage,
    meta: RequestMeta,
    db: Db = this.database.db,
  ): Promise<NewSession> {
    const token = randomBytes(32).toString('base64url');
    const lifetimeSeconds =
      stage === 'full' ? SESSION_MAX_HOURS * 3600 : PENDING_SESSION_MINUTES * 60;
    await db
      .insertInto('admin_sessions')
      .values({
        admin_id: adminId,
        token_hash: hashToken(token),
        stage,
        ip: meta.ip,
        user_agent: meta.userAgent,
        expires_at: new Date(Date.now() + lifetimeSeconds * 1000),
      })
      .execute();
    return { token, maxAgeSeconds: lifetimeSeconds };
  }

  /** Ends the current session and starts the next stage with a new token (no session fixation). */
  async rotate(
    current: AuthedAdmin,
    stage: SessionStage,
    meta: RequestMeta,
    db: Db = this.database.db,
  ): Promise<NewSession> {
    await this.end(current.sessionId, 'next login step', db);
    return this.create(current.id, stage, meta, db);
  }

  /** Checks the cookie token. Ends the session (and refuses) if expired, idle or disabled. */
  async authenticate(token: string, meta: RequestMeta): Promise<AuthedAdmin> {
    const db = this.database.db;
    const row = await db
      .selectFrom('admin_sessions as s')
      .innerJoin('admins as a', 'a.id', 's.admin_id')
      .select([
        's.id as session_id',
        's.stage',
        's.expires_at',
        's.last_seen_at',
        's.ended_at',
        'a.id as admin_id',
        'a.role',
        'a.status',
        'a.name',
        'a.email',
      ])
      .where('s.token_hash', '=', hashToken(token))
      .executeTakeFirst();
    if (!row || row.ended_at) throw notLoggedIn();

    const now = Date.now();
    let endReason: string | null = null;
    if (row.expires_at.getTime() <= now) endReason = 'expired';
    else if (
      row.stage === 'full' &&
      row.last_seen_at.getTime() <= now - IDLE_TIMEOUT_MINUTES * 60_000
    )
      endReason = 'idle';
    else if (row.status !== 'active') endReason = 'account disabled';

    if (endReason) {
      await this.end(row.session_id, endReason);
      await this.audit.record(
        {
          action: 'auth.session_expired',
          admin_id: row.admin_id,
          session_id: row.session_id,
          reason: endReason,
        },
        meta,
      );
      throw notLoggedIn();
    }

    await db
      .updateTable('admin_sessions')
      .set({ last_seen_at: new Date() })
      .where('id', '=', row.session_id)
      .execute();
    return {
      id: row.admin_id,
      role: row.role,
      name: row.name,
      email: row.email,
      sessionId: row.session_id,
      stage: row.stage,
    };
  }

  async end(sessionId: string, reason: string, db: Db = this.database.db): Promise<void> {
    await db
      .updateTable('admin_sessions')
      .set({ ended_at: new Date(), end_reason: reason })
      .where('id', '=', sessionId)
      .where('ended_at', 'is', null)
      .execute();
  }

  /** Ends every open session of an admin, optionally keeping one (the caller's own). */
  async endAllForAdmin(
    adminId: string,
    reason: string,
    exceptSessionId?: string,
    db: Db = this.database.db,
  ): Promise<void> {
    let query = db
      .updateTable('admin_sessions')
      .set({ ended_at: new Date(), end_reason: reason })
      .where('admin_id', '=', adminId)
      .where('ended_at', 'is', null);
    if (exceptSessionId) query = query.where('id', '!=', exceptSessionId);
    await query.execute();
  }
}
