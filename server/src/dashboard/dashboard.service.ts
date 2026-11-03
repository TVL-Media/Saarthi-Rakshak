import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { MAX_SMS_ATTEMPTS } from '../alerts/alerts.constants';
import { DatabaseService } from '../database/database.module';
import { HealthService, type HealthState } from '../health/health.service';
import { DEFAULT_SETTINGS } from '../settings/default-settings';

export const ATTENTION_LIMIT = 10;
export const RECENT_LIMIT = 15;

/** Start of today in India, as SQL. */
const TODAY_IST = sql`(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`;

/** What needs attention, most urgent first. Never names a person or shows a phone number. */
export type AttentionItem =
  | { kind: 'sos_no_response'; sosId: string; since: Date }
  | { kind: 'sos_lost_contact'; sosId: string; since: Date }
  | { kind: 'checkin_no_reply'; journeyId: string; since: Date }
  | { kind: 'sms_all_failed'; sosId: string | null; journeyId: string | null; since: Date }
  | { kind: 'journey_lost_contact'; journeyId: string; since: Date }
  | { kind: 'setup_unfinished'; count: number };

/** Recent events, newest first. No names or phone numbers (rule 6, and the screen may be seen by others). */
export interface RecentEvent {
  kind:
    | 'user_signed_up'
    | 'sos_started'
    | 'sos_ended'
    | 'sos_cancelled'
    | 'journey_started'
    | 'journey_arrived';
  at: Date;
  /** SOS lines link to History. */
  sosId: string | null;
}

export interface DashboardSummary {
  counts: {
    activeSos: number;
    activeJourneys: number;
    sosToday: number;
    newUsersToday: number;
    failedAlertsToday: number;
  };
  health: {
    server: 'working';
    database: HealthState;
    redis: HealthState;
    push: 'not_set_up';
    smsMain: 'not_set_up';
    smsBackup: 'not_set_up';
  };
  attention: AttentionItem[];
  recent: RecentEvent[];
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly database: DatabaseService,
    private readonly health: HealthService,
  ) {}

  async summary(): Promise<DashboardSummary> {
    const [counts, health, attention, recent] = await Promise.all([
      this.counts(),
      this.health.detailed(),
      this.attention(),
      this.recent(),
    ]);
    return {
      counts,
      health: {
        server: 'working',
        ...health,
        push: 'not_set_up',
        smsMain: 'not_set_up',
        smsBackup: 'not_set_up',
      },
      attention,
      recent,
    };
  }

  private async counts(): Promise<DashboardSummary['counts']> {
    const { rows } = await sql<{
      active_sos: string;
      active_journeys: string;
      sos_today: string;
      new_users_today: string;
      failed_alerts_today: string;
    }>`
      SELECT
        (SELECT count(*) FROM sos_events WHERE status = 'active') AS active_sos,
        (SELECT count(*) FROM journeys WHERE status = 'active') AS active_journeys,
        (SELECT count(*) FROM sos_events WHERE started_at >= ${TODAY_IST} AND NOT is_test) AS sos_today,
        (SELECT count(*) FROM users WHERE created_at >= ${TODAY_IST}) AS new_users_today,
        (SELECT count(*) FROM alerts a
          WHERE a.created_at >= ${TODAY_IST} AND a.status = 'failed'
            AND NOT EXISTS (
              SELECT 1 FROM alerts b
              WHERE b.guardian_id IS NOT DISTINCT FROM a.guardian_id
                AND b.sos_event_id IS NOT DISTINCT FROM a.sos_event_id
                AND b.journey_id IS NOT DISTINCT FROM a.journey_id
                AND b.channel = a.channel AND b.status IN ('sent', 'delivered')
                AND (b.created_at, b.id) > (a.created_at, a.id))) AS failed_alerts_today
    `.execute(this.database.db);
    const r = rows[0];
    return {
      activeSos: Number(r.active_sos),
      activeJourneys: Number(r.active_journeys),
      sosToday: Number(r.sos_today),
      newUsersToday: Number(r.new_users_today),
      failedAlertsToday: Number(r.failed_alerts_today),
    };
  }

  /** The "Lost contact" rule from Settings (minutes), or its default. */
  private async lostContactMinutes(): Promise<number> {
    const row = await this.database.db
      .selectFrom('settings')
      .select('value')
      .where('key', '=', 'journey.lost_contact_minutes')
      .executeTakeFirst();
    return typeof row?.value === 'number'
      ? row.value
      : DEFAULT_SETTINGS['journey.lost_contact_minutes'].value;
  }

  private async attention(): Promise<AttentionItem[]> {
    const db = this.database.db;
    const lostMinutes = await this.lostContactMinutes();
    const items: AttentionItem[] = [];

    // 1. Active SOS where no guardian has responded yet.
    const { rows: noResponse } = await sql<{ id: string; started_at: Date }>`
      SELECT s.id, s.started_at FROM sos_events s
      WHERE s.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM guardian_links l WHERE l.sos_event_id = s.id AND l.responding_at IS NOT NULL)
      ORDER BY s.started_at
    `.execute(db);
    items.push(
      ...noResponse.map((r) => ({
        kind: 'sos_no_response' as const,
        sosId: r.id,
        since: r.started_at,
      })),
    );

    // 2. Active SOS with lost contact: no location for longer than the "Lost contact" rule.
    const { rows: lost } = await sql<{ id: string; last: Date }>`
      SELECT s.id, coalesce(max(p.recorded_at), s.started_at) AS last
      FROM sos_events s LEFT JOIN location_points p ON p.sos_event_id = s.id
      WHERE s.status = 'active'
      GROUP BY s.id, s.started_at
      HAVING coalesce(max(p.recorded_at), s.started_at) < now() - make_interval(mins => ${lostMinutes})
      ORDER BY last
    `.execute(db);
    items.push(
      ...lost.map((r) => ({ kind: 'sos_lost_contact' as const, sosId: r.id, since: r.last })),
    );

    // 3. Check-ins not answered in the last 24 hours (guardians were alerted).
    const noReply = await db
      .selectFrom('checkins')
      .select(['journey_id', 'asked_at'])
      .where('status', '=', 'no_reply')
      .where('asked_at', '>=', sql<Date>`now() - interval '24 hours'`)
      .orderBy('asked_at', 'desc')
      .execute();
    items.push(
      ...noReply.map((r) => ({
        kind: 'checkin_no_reply' as const,
        journeyId: r.journey_id,
        since: r.asked_at,
      })),
    );

    // 4. SMS where all tries failed in the last 24 hours (not fixed by a later try).
    const { rows: smsFailed } = await sql<{
      sos_event_id: string | null;
      journey_id: string | null;
      created_at: Date;
    }>`
      SELECT a.sos_event_id, a.journey_id, a.created_at FROM alerts a
      WHERE a.channel = 'sms' AND a.status = 'failed'
        AND a.attempt >= ${MAX_SMS_ATTEMPTS}
        AND a.created_at >= now() - interval '24 hours'
        AND NOT EXISTS (
          SELECT 1 FROM alerts b
          WHERE b.guardian_id IS NOT DISTINCT FROM a.guardian_id
            AND b.sos_event_id IS NOT DISTINCT FROM a.sos_event_id
            AND b.journey_id IS NOT DISTINCT FROM a.journey_id
            AND b.channel = a.channel AND b.status IN ('sent', 'delivered')
            AND (b.created_at, b.id) > (a.created_at, a.id))
      ORDER BY a.created_at DESC
    `.execute(db);
    items.push(
      ...smsFailed.map((r) => ({
        kind: 'sms_all_failed' as const,
        sosId: r.sos_event_id,
        journeyId: r.journey_id,
        since: r.created_at,
      })),
    );

    // 5. Journeys with lost contact in the last 24 hours. The worker keeps such a journey active
    // and sets lost_contact_at (cleared when the phone is heard again), and sends guardians a
    // lost_contact SMS; an old-style status 'lost_contact' still counts.
    const { rows: lostJourneys } = await sql<{ id: string; since: Date }>`
      SELECT j.id,
             coalesce(j.lost_contact_at, max(a.created_at), j.ended_at, j.started_at) AS since
      FROM journeys j
      LEFT JOIN alerts a ON a.journey_id = j.id AND a.type = 'lost_contact'
        AND a.created_at >= now() - interval '24 hours'
      WHERE j.lost_contact_at IS NOT NULL
         OR a.id IS NOT NULL
         OR (j.status = 'lost_contact' AND coalesce(j.ended_at, j.started_at) >= now() - interval '24 hours')
      GROUP BY j.id
      ORDER BY since DESC
    `.execute(db);
    items.push(
      ...lostJourneys.map((r) => ({
        kind: 'journey_lost_contact' as const,
        journeyId: r.id,
        since: r.since,
      })),
    );

    // 6. Users with unfinished setup: one line with a count.
    const { rows: unfinished } = await sql<{ n: string }>`
      SELECT count(*) AS n FROM users u
      LEFT JOIN LATERAL (
        SELECT * FROM devices dv WHERE dv.user_id = u.id
        ORDER BY dv.last_seen_at DESC NULLS LAST, dv.created_at DESC LIMIT 1
      ) d ON true
      WHERE NOT (
        coalesce(d.battery_optimisation_off, false)
        AND coalesce((d.permissions ->> 'location')::boolean, false)
        AND coalesce((d.permissions ->> 'notifications')::boolean, false)
        AND coalesce((d.permissions ->> 'sms')::boolean, false)
        AND coalesce((d.permissions ->> 'microphone')::boolean, false)
        AND EXISTS (SELECT 1 FROM guardians g WHERE g.user_id = u.id AND g.invite_status = 'accepted')
      )
    `.execute(db);
    const count = Number(unfinished[0].n);
    const list = items.slice(0, count > 0 ? ATTENTION_LIMIT - 1 : ATTENTION_LIMIT);
    if (count > 0) list.push({ kind: 'setup_unfinished', count });
    return list;
  }

  private async recent(): Promise<RecentEvent[]> {
    const { rows } = await sql<{ kind: RecentEvent['kind']; at: Date; sos_id: string | null }>`
      SELECT * FROM (
        SELECT 'user_signed_up' AS kind, created_at AS at, NULL::uuid AS sos_id FROM users
        UNION ALL SELECT 'sos_started', started_at, id FROM sos_events WHERE NOT is_test
        UNION ALL SELECT CASE status WHEN 'cancelled' THEN 'sos_cancelled' ELSE 'sos_ended' END, ended_at, id
                  FROM sos_events WHERE ended_at IS NOT NULL AND NOT is_test
        UNION ALL SELECT 'journey_started', started_at, NULL FROM journeys
        UNION ALL SELECT 'journey_arrived', ended_at, NULL FROM journeys
                  WHERE status = 'arrived' AND ended_at IS NOT NULL
      ) e
      ORDER BY at DESC
      LIMIT ${RECENT_LIMIT}
    `.execute(this.database.db);
    return rows.map((r) => ({ kind: r.kind, at: r.at, sosId: r.sos_id }));
  }
}
