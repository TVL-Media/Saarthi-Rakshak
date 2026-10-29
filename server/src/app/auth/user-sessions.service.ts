import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DatabaseService } from '../../database/database.module';
import type { Database } from '../../database/types';
import type { AuthedUser } from '../common/app-http';

type Db = Kysely<Database> | Transaction<Database>;

/** A session ends after this many days without use. */
export const SESSION_DAYS = 90;
/** Moving the expiry forward (and the user's "last seen") is written at most this often. */
const TOUCH_EVERY_SECONDS = 60;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** App login sessions: one open session per user (decided: one phone at a time). */
@Injectable()
export class UserSessionsService {
  constructor(private readonly database: DatabaseService) {}

  /** Ends any open session for the user and starts a new one. Returns the token (shown once). */
  async start(userId: string, db: Db = this.database.db): Promise<string> {
    await this.endAll(userId, 'new_login', db);
    const token = randomBytes(32).toString('base64url');
    await db
      .insertInto('user_sessions')
      .values({
        user_id: userId,
        token_hash: hashToken(token),
        expires_at: sql<Date>`now() + make_interval(days => ${SESSION_DAYS})`,
      })
      .execute();
    return token;
  }

  /** The user behind a token, or null if the token is unknown, ended or expired. */
  async authenticate(token: string): Promise<AuthedUser | null> {
    const row = await this.database.db
      .selectFrom('user_sessions as s')
      .innerJoin('users as u', 'u.id', 's.user_id')
      .select([
        's.id as sessionId',
        's.last_seen_at as lastSeenAt',
        'u.id as userId',
        'u.status',
        'u.consent_at as consentAt',
      ])
      .where('s.token_hash', '=', hashToken(token))
      .where('s.ended_at', 'is', null)
      .where('s.expires_at', '>', sql<Date>`now()`)
      .executeTakeFirst();
    if (!row) return null;

    if (Date.now() - row.lastSeenAt.getTime() > TOUCH_EVERY_SECONDS * 1000) {
      await this.database.db
        .updateTable('user_sessions')
        .set({
          last_seen_at: sql<Date>`now()`,
          expires_at: sql<Date>`now() + make_interval(days => ${SESSION_DAYS})`,
        })
        .where('id', '=', row.sessionId)
        .execute();
      await this.database.db
        .updateTable('users')
        .set({ last_seen_at: sql<Date>`now()` })
        .where('id', '=', row.userId)
        .execute();
    }
    return {
      id: row.userId,
      sessionId: row.sessionId,
      status: row.status,
      consentGiven: row.consentAt !== null,
    };
  }

  async end(sessionId: string, reason: 'logout'): Promise<void> {
    await this.database.db
      .updateTable('user_sessions')
      .set({ ended_at: sql<Date>`now()`, end_reason: reason })
      .where('id', '=', sessionId)
      .where('ended_at', 'is', null)
      .execute();
  }

  async endAll(
    userId: string,
    reason: 'new_login' | 'account_deleted',
    db: Db = this.database.db,
  ): Promise<void> {
    await db
      .updateTable('user_sessions')
      .set({ ended_at: sql<Date>`now()`, end_reason: reason })
      .where('user_id', '=', userId)
      .where('ended_at', 'is', null)
      .execute();
  }
}
