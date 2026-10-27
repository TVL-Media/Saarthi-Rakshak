import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import { AuditService } from '../audit/audit.service';
import type { AuthedAdmin, RequestMeta } from '../common/http';
import { deleteUserData } from '../database/delete-user-data';
import { DatabaseService } from '../database/database.module';
import { maskPhone } from './phone';

export const USERS_PAGE_SIZE = 50;

/**
 * Permissions the app needs (keys in devices.permissions). To be kept in step with the app.
 * "Setup complete" = all of these granted + battery saving off + at least one accepted guardian.
 */
export const REQUIRED_PERMISSIONS = ['location', 'notifications', 'sms', 'microphone'] as const;

/** SQL: true when the user's latest device and guardians meet "Setup complete". */
function setupCompleteSql(): RawBuilder<boolean> {
  const permissions = REQUIRED_PERMISSIONS.map(
    (p) => sql`coalesce((d.permissions ->> ${p})::boolean, false)`,
  );
  return sql<boolean>`(
    coalesce(d.battery_optimisation_off, false)
    AND ${sql.join(permissions, sql` AND `)}
    AND EXISTS (SELECT 1 FROM guardians g WHERE g.user_id = u.id AND g.invite_status = 'accepted')
  )`;
}

/** The latest device per user (by last seen). */
const LATEST_DEVICE = sql`LEFT JOIN LATERAL (
  SELECT * FROM devices dv WHERE dv.user_id = u.id
  ORDER BY dv.last_seen_at DESC NULLS LAST, dv.created_at DESC LIMIT 1
) d ON true`;

export interface UserRow {
  id: string;
  name: string | null;
  phone: string | null; // masked
  setupComplete: boolean;
  guardiansAccepted: number;
  guardiansTotal: number;
  appVersion: string | null;
  lastSeenAt: Date | null;
  status: 'active' | 'blocked';
}

export interface UserSearch {
  /** Exact full number, already normalised (+91…). */
  phone?: string;
  setup?: 'complete' | 'unfinished';
  status?: 'active' | 'blocked';
  /** "Load more": continue after this user id. */
  after?: string;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** Newest users first, 50 per page. Phones are masked before they leave the server. */
  async list(search: UserSearch): Promise<{ users: UserRow[]; more: boolean }> {
    const where = [sql`true`];
    if (search.phone) where.push(sql`u.phone = ${search.phone}`);
    if (search.status) where.push(sql`u.status = ${search.status}`);
    if (search.setup) {
      where.push(search.setup === 'complete' ? setupCompleteSql() : sql`NOT ${setupCompleteSql()}`);
    }
    if (search.after) {
      where.push(
        sql`(u.created_at, u.id) < (SELECT created_at, id FROM users WHERE id = ${search.after})`,
      );
    }

    const { rows } = await sql<{
      id: string;
      name: string | null;
      phone: string;
      status: 'active' | 'blocked';
      last_seen_at: Date | null;
      app_version: string | null;
      setup_complete: boolean;
      guardians_accepted: string;
      guardians_total: string;
    }>`
      SELECT u.id, u.name, u.phone, u.status,
             coalesce(u.last_seen_at, d.last_seen_at) AS last_seen_at,
             d.app_version,
             ${setupCompleteSql()} AS setup_complete,
             (SELECT count(*) FROM guardians g WHERE g.user_id = u.id AND g.invite_status = 'accepted') AS guardians_accepted,
             (SELECT count(*) FROM guardians g WHERE g.user_id = u.id AND g.invite_status <> 'declined') AS guardians_total
      FROM users u
      ${LATEST_DEVICE}
      WHERE ${sql.join(where, sql` AND `)}
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT ${USERS_PAGE_SIZE + 1}
    `.execute(this.database.db);

    return {
      more: rows.length > USERS_PAGE_SIZE,
      users: rows.slice(0, USERS_PAGE_SIZE).map((r) => ({
        id: r.id,
        name: r.name,
        phone: maskPhone(r.phone),
        setupComplete: r.setup_complete,
        guardiansAccepted: Number(r.guardians_accepted),
        guardiansTotal: Number(r.guardians_total),
        appVersion: r.app_version,
        lastSeenAt: r.last_seen_at,
        status: r.status,
      })),
    };
  }

  /** One user's profile. Phones masked; journeys and SOS listed read-only. */
  async profile(id: string) {
    const db = this.database.db;
    const { rows } = await sql<{
      id: string;
      name: string | null;
      phone: string;
      status: 'active' | 'blocked';
      created_at: Date;
      last_seen_at: Date | null;
      device_model: string | null;
      android_version: string | null;
      app_version: string | null;
      device_last_seen_at: Date | null;
      permissions: Record<string, unknown> | null;
      battery_optimisation_off: boolean | null;
      setup_complete: boolean;
    }>`
      SELECT u.id, u.name, u.phone, u.status, u.created_at, u.last_seen_at,
             d.model AS device_model, d.android_version, d.app_version,
             d.last_seen_at AS device_last_seen_at, d.permissions, d.battery_optimisation_off,
             ${setupCompleteSql()} AS setup_complete
      FROM users u ${LATEST_DEVICE}
      WHERE u.id = ${id}
    `.execute(db);
    const u = rows[0];
    if (!u) throw new NotFoundException('User not found');

    const guardians = await db
      .selectFrom('guardians as g')
      .select([
        'g.id',
        'g.name',
        'g.phone',
        'g.invite_status',
        (eb) =>
          eb
            .selectFrom('alerts as a')
            .select((e) => e.fn.max('a.created_at').as('m'))
            .whereRef('a.guardian_id', '=', 'g.id')
            .as('last_alert_at'),
      ])
      .where('g.user_id', '=', id)
      .orderBy('g.created_at')
      .execute();

    const { rows: activity } = await sql<{
      type: 'sos' | 'journey';
      id: string;
      started_at: Date;
      ended_at: Date | null;
      status: string;
      is_test: boolean;
      trigger: string | null;
    }>`
      (SELECT 'sos' AS type, id, started_at, ended_at, status, is_test, trigger
         FROM sos_events WHERE user_id = ${id})
      UNION ALL
      (SELECT 'journey' AS type, id, started_at, ended_at, status, false AS is_test, NULL AS trigger
         FROM journeys WHERE user_id = ${id})
      ORDER BY started_at DESC
      LIMIT 10
    `.execute(db);

    const permissions = u.permissions ?? {};
    return {
      id: u.id,
      name: u.name,
      phone: maskPhone(u.phone),
      status: u.status,
      createdAt: u.created_at,
      lastSeenAt: u.last_seen_at ?? u.device_last_seen_at,
      setup: {
        complete: u.setup_complete,
        permissions: Object.fromEntries(
          REQUIRED_PERMISSIONS.map((p) => [p, permissions[p] === true]),
        ) as Record<(typeof REQUIRED_PERMISSIONS)[number], boolean>,
        batteryOptimisationOff: u.battery_optimisation_off === true,
        guardianAccepted: guardians.some((g) => g.invite_status === 'accepted'),
      },
      device:
        u.device_model || u.app_version
          ? {
              model: u.device_model,
              androidVersion: u.android_version,
              appVersion: u.app_version,
              lastSeenAt: u.device_last_seen_at,
            }
          : null,
      guardians: guardians.map((g) => ({
        id: g.id,
        name: g.name,
        phone: maskPhone(g.phone),
        inviteStatus: g.invite_status,
        lastAlertAt: g.last_alert_at ?? null,
      })),
      activity: activity.map((a) => ({
        type: a.type,
        id: a.id,
        startedAt: a.started_at,
        endedAt: a.ended_at,
        status: a.status,
        isTest: a.is_test,
        trigger: a.trigger,
      })),
    };
  }

  /**
   * Block: stops login, new journeys and new guardian invites. Never ends an SOS or a journey
   * already running, and SOS always works for a blocked user.
   */
  async setBlocked(
    actor: AuthedAdmin,
    id: string,
    blocked: boolean,
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.database.db.transaction().execute(async (trx) => {
      const user = await trx
        .selectFrom('users')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirst();
      if (!user) throw new NotFoundException('User not found');
      if ((user.status === 'blocked') === blocked) {
        throw new BadRequestException(
          blocked ? 'This user is already blocked' : 'This user is not blocked',
        );
      }
      await trx
        .updateTable('users')
        .set({ status: blocked ? 'blocked' : 'active' })
        .where('id', '=', id)
        .execute();
      await this.audit.record(
        {
          action: blocked ? 'user.blocked' : 'user.unblocked',
          admin_id: actor.id,
          session_id: actor.sessionId,
          target_type: 'user',
          target_id: id,
          reason,
        },
        meta,
        trx,
      );
    });
  }

  /**
   * "Delete data" (Super Admin): removes everything personal; SOS events and alerts stay with no
   * link to the person. Refused while an SOS or journey is running, and while the user has audio
   * recordings (file storage is not connected yet, so they could not be deleted).
   */
  async deleteData(
    actor: AuthedAdmin,
    id: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<void> {
    await this.database.db.transaction().execute(async (trx) => {
      // Lock the user so nothing starts for them while their data is being deleted.
      const user = await trx
        .selectFrom('users')
        .select('id')
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!user) throw new NotFoundException('User not found');

      const running = await sql<{ n: string }>`
        SELECT (SELECT count(*) FROM sos_events WHERE user_id = ${id} AND status = 'active')
             + (SELECT count(*) FROM journeys WHERE user_id = ${id} AND status = 'active') AS n
      `.execute(trx);
      if (Number(running.rows[0].n) > 0) {
        throw new ConflictException(
          'This user has an SOS or journey running. Their data can be deleted after it ends.',
        );
      }
      const clips = await trx
        .selectFrom('media_clips')
        .select('id')
        .where('user_id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (clips) {
        throw new ConflictException(
          'This user has audio recordings. They can be deleted once the file storage is set up.',
        );
      }

      await deleteUserData(trx, id);
      await this.audit.record(
        {
          action: 'user.data_deleted',
          admin_id: actor.id,
          session_id: actor.sessionId,
          target_type: 'user',
          target_id: id,
          reason,
        },
        meta,
        trx,
      );
    });
  }
}
