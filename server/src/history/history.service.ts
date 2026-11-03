import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import { DatabaseService } from '../database/database.module';
import { GUARDIAN_NUMBER, guardianLabel } from '../alerts/guardian-label';
import { maskPhone } from '../users/phone';

export const HISTORY_PAGE_SIZE = 50;
/** A pause of this long or more between location updates shows as a gap. Fixed in code. */
export const LOCATION_GAP_SECONDS = 120;

export type Outcome =
  'active' | 'ended_safe' | 'cancelled' | 'arrived' | 'ended' | 'lost_contact' | 'turned_into_sos';

export interface HistoryFilters {
  type: 'all' | 'sos' | 'journey';
  real: 'all' | 'real' | 'test';
  outcome?: Outcome;
  /** India dates (YYYY-MM-DD), both included. */
  from?: string;
  to?: string;
  /** "Load more": the `cursor` of the last row shown. */
  before?: string;
}

export interface HistoryRow {
  type: 'sos' | 'journey';
  id: string;
  /** Opaque, for "Load more". */
  cursor: string;
  startedAt: Date;
  endedAt: Date | null;
  isTest: boolean;
  /** How the SOS started (SOS only). */
  trigger: string | null;
  /** SOS only. null name/phone = the user deleted their data ("Deleted user"). Journeys: never. */
  user: { id: string; name: string | null; phone: string | null } | null;
  userDeleted: boolean;
  guardiansAlerted: number;
  outcome: Outcome;
  /** Journey that turned into an SOS: that SOS. */
  sosId: string | null;
}

/** One SOS or journey row (both kinds share these columns). */
const ROWS = sql`
  SELECT 'sos'::text AS type, s.id::text AS id, s.started_at, s.ended_at, s.is_test, s.trigger,
         s.user_id::text AS user_id, u.name AS user_name, u.phone AS user_phone,
         (SELECT count(DISTINCT a.guardian_id) FROM alerts a WHERE a.sos_event_id = s.id) AS guardians_alerted,
         CASE s.status WHEN 'active' THEN 'active' WHEN 'cancelled' THEN 'cancelled' ELSE 'ended_safe' END AS outcome,
         NULL::text AS sos_id
  FROM sos_events s LEFT JOIN users u ON u.id = s.user_id
  UNION ALL
  SELECT 'journey', j.id::text, j.started_at, j.ended_at, false, NULL,
         NULL, NULL, NULL,
         (SELECT count(DISTINCT a.guardian_id) FROM alerts a WHERE a.journey_id = j.id),
         CASE WHEN linked.id IS NOT NULL THEN 'turned_into_sos' ELSE j.status END,
         linked.id::text
  FROM journeys j
  LEFT JOIN LATERAL (
    SELECT s.id FROM sos_events s WHERE s.journey_id = j.id ORDER BY s.started_at LIMIT 1
  ) linked ON true
`;

function encodeCursor(startedAt: Date, type: string, id: string): string {
  return Buffer.from(`${startedAt.toISOString()}|${type}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): [string, string] {
  const [iso, type, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!iso || !type || !id || Number.isNaN(Date.parse(iso)))
    throw new BadRequestException('Invalid page');
  return [iso, `${type}|${id}`];
}

export interface TimelineEvent {
  at: Date;
  kind:
    | 'started'
    | 'alert'
    | 'alert_delivered'
    | 'alert_failed'
    | 'link_opened'
    | 'responding'
    | 'location_gap'
    | 'checkin_asked'
    | 'checkin_answered'
    | 'turned_into_sos'
    | 'ended';
  text: string;
  /** Red in the timeline (failed alert, no reply, lost contact). */
  warning?: boolean;
}

const CHANNEL: Record<string, string> = { sms: 'SMS', push: 'Push', sim_sms: 'SMS from the phone' };
const TRIGGER: Record<string, string> = {
  button: 'SOS button',
  widget: 'home-screen widget',
  tile: 'quick-settings tile',
  checkin: 'check-in',
  journey: 'journey',
};
const CHECKIN_REASON: Record<string, string> = {
  off_route: 'off route',
  stopped: 'stopped too long',
  late: 'late arrival',
};
const CHECKIN_ANSWER: Record<string, string> = {
  fine: 'User replied: I’m fine',
  traffic_pause: 'User replied: Stuck in traffic (check-ins paused)',
  sos: 'User replied: SOS',
  no_reply: 'No reply: guardians alerted',
};

@Injectable()
export class HistoryService {
  constructor(private readonly database: DatabaseService) {}

  /** Newest first, 50 per page. Read-only. */
  async list(filters: HistoryFilters): Promise<{ rows: HistoryRow[]; more: boolean }> {
    const where: RawBuilder<unknown>[] = [sql`true`];
    if (filters.type !== 'all') where.push(sql`h.type = ${filters.type}`);
    if (filters.real === 'real') where.push(sql`NOT h.is_test`);
    if (filters.real === 'test') where.push(sql`h.is_test`);
    if (filters.outcome) where.push(sql`h.outcome = ${filters.outcome}`);
    if (filters.from) {
      where.push(
        sql`h.started_at >= (${filters.from}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'`,
      );
    }
    if (filters.to) {
      where.push(
        sql`h.started_at < ((${filters.to}::date) + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'`,
      );
    }
    if (filters.before) {
      const [iso, key] = decodeCursor(filters.before);
      where.push(sql`(h.started_at, h.type || '|' || h.id) < (${iso}::timestamptz, ${key})`);
    }

    const { rows } = await sql<{
      type: 'sos' | 'journey';
      id: string;
      started_at: Date;
      ended_at: Date | null;
      is_test: boolean;
      trigger: string | null;
      user_id: string | null;
      user_name: string | null;
      user_phone: string | null;
      guardians_alerted: string;
      outcome: Outcome;
      sos_id: string | null;
    }>`
      SELECT * FROM (${ROWS}) h
      WHERE ${sql.join(where, sql` AND `)}
      ORDER BY h.started_at DESC, h.type || '|' || h.id DESC
      LIMIT ${HISTORY_PAGE_SIZE + 1}
    `.execute(this.database.db);

    return {
      more: rows.length > HISTORY_PAGE_SIZE,
      rows: rows.slice(0, HISTORY_PAGE_SIZE).map((r) => ({
        type: r.type,
        id: r.id,
        cursor: encodeCursor(r.started_at, r.type, r.id),
        startedAt: r.started_at,
        endedAt: r.ended_at,
        isTest: r.is_test,
        trigger: r.trigger,
        // Journeys never name the person (rule 6); deleted users have no link.
        user:
          r.type === 'sos' && r.user_id
            ? { id: r.user_id, name: r.user_name, phone: maskPhone(r.user_phone) }
            : null,
        userDeleted: r.type === 'sos' && !r.user_id,
        guardiansAlerted: Number(r.guardians_alerted),
        outcome: r.outcome,
        sosId: r.sos_id,
      })),
    };
  }

  /**
   * Minute-by-minute timeline of one SOS or journey. Guardians appear as "Guardian 1 (brother)"
   * with a masked phone; location only as gaps (never coordinates or a map).
   */
  async timeline(
    type: 'sos' | 'journey',
    id: string,
  ): Promise<{ row: HistoryRow; events: TimelineEvent[] }> {
    const row = await this.rowById(type, id);
    const column = type === 'sos' ? sql.ref('sos_event_id') : sql.ref('journey_id');

    // Guardians involved, numbered in the order the user added them (same as the Alert Log).
    const { rows: guardians } = await sql<{
      id: string;
      number: number;
      relation: string | null;
      phone: string | null;
    }>`
      SELECT g.id, ${GUARDIAN_NUMBER} AS number, g.relation, g.phone FROM guardians g
      WHERE g.id IN (SELECT guardian_id FROM alerts WHERE ${column} = ${id}
                     UNION SELECT guardian_id FROM guardian_links WHERE ${column} = ${id})
    `.execute(this.database.db);
    const label = new Map(guardians.map((g) => [g.id, guardianLabel(g)]));
    const who = (guardianId: string | null) =>
      (guardianId && label.get(guardianId)) ?? guardianLabel(null);

    const events: TimelineEvent[] = [];
    if (type === 'sos') {
      const sos = await this.database.db
        .selectFrom('sos_events')
        .select(['started_at', 'ended_at', 'status', 'trigger', 'end_reason'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      events.push({
        at: new Date(sos.started_at),
        kind: 'started',
        text: `SOS started (${TRIGGER[sos.trigger] ?? sos.trigger})`,
      });
      if (sos.ended_at) {
        events.push({
          at: sos.ended_at,
          kind: 'ended',
          text: sos.status === 'cancelled' ? 'Cancelled in the countdown' : 'Ended: user safe',
        });
      }
    } else {
      const journey = await this.database.db
        .selectFrom('journeys')
        .select(['started_at', 'ended_at', 'status'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      events.push({
        at: new Date(journey.started_at),
        kind: 'started',
        text: 'Journey started',
      });
      if (row.sosId) {
        const sos = await this.database.db
          .selectFrom('sos_events')
          .select('started_at')
          .where('id', '=', row.sosId)
          .executeTakeFirstOrThrow();
        events.push({
          at: new Date(sos.started_at),
          kind: 'turned_into_sos',
          text: 'Turned into SOS',
          warning: true,
        });
      }
      if (journey.ended_at) {
        const text: Record<string, string> = {
          arrived: 'Arrived safely',
          lost_contact: 'Lost contact: guardians alerted',
          ended: 'Journey ended',
        };
        events.push({
          at: journey.ended_at,
          kind: 'ended',
          text: text[journey.status] ?? 'Journey ended',
          warning: journey.status === 'lost_contact',
        });
      }
      const checkins = await this.database.db
        .selectFrom('checkins')
        .select(['reason', 'status', 'asked_at', 'answered_at'])
        .where('journey_id', '=', id)
        .execute();
      for (const c of checkins) {
        events.push({
          at: new Date(c.asked_at),
          kind: 'checkin_asked',
          text: `Check-in asked (${CHECKIN_REASON[c.reason] ?? c.reason})`,
        });
        if (c.status !== 'pending') {
          events.push({
            at: c.answered_at ?? new Date(c.asked_at),
            kind: 'checkin_answered',
            text: CHECKIN_ANSWER[c.status] ?? c.status,
            warning: c.status === 'no_reply' || c.status === 'sos',
          });
        }
      }
    }

    const alerts = await this.database.db
      .selectFrom('alerts')
      .select([
        'guardian_id',
        'channel',
        'status',
        'created_at',
        'sent_at',
        'delivered_at',
        'attempt',
      ])
      .where(type === 'sos' ? 'sos_event_id' : 'journey_id', '=', id)
      .execute();
    for (const a of alerts) {
      const channel = CHANNEL[a.channel] ?? a.channel;
      const retry = a.attempt > 1 ? ` (try ${a.attempt})` : '';
      events.push({
        at: a.sent_at ?? a.created_at,
        kind: 'alert',
        text: `${channel} sent to ${who(a.guardian_id)}${retry}`,
      });
      if (a.delivered_at) {
        events.push({
          at: a.delivered_at,
          kind: 'alert_delivered',
          text: `${channel} delivered to ${who(a.guardian_id)}`,
        });
      }
      if (a.status === 'failed') {
        events.push({
          at: a.sent_at ?? a.created_at,
          kind: 'alert_failed',
          text: `${channel} to ${who(a.guardian_id)} failed`,
          warning: true,
        });
      }
    }

    const links = await this.database.db
      .selectFrom('guardian_links')
      .select(['guardian_id', 'opened_at', 'responding_at'])
      .where(type === 'sos' ? 'sos_event_id' : 'journey_id', '=', id)
      .execute();
    for (const l of links) {
      if (l.opened_at)
        events.push({
          at: l.opened_at,
          kind: 'link_opened',
          text: `${who(l.guardian_id)} opened the live link`,
        });
      if (l.responding_at)
        events.push({
          at: l.responding_at,
          kind: 'responding',
          text: `${who(l.guardian_id)} is responding`,
        });
    }

    // Location: only as gaps between updates, never coordinates.
    const { rows: gaps } = await sql<{ gap_start: Date; seconds: number }>`
      SELECT prev AS gap_start, EXTRACT(EPOCH FROM recorded_at - prev)::int AS seconds
      FROM (
        SELECT recorded_at, lag(recorded_at) OVER (ORDER BY recorded_at) AS prev
        FROM location_points WHERE ${column} = ${id}
      ) p
      WHERE prev IS NOT NULL AND recorded_at - prev >= make_interval(secs => ${LOCATION_GAP_SECONDS})
    `.execute(this.database.db);
    for (const g of gaps) {
      events.push({
        at: g.gap_start,
        kind: 'location_gap',
        text: `No location for ${Math.round(g.seconds / 60)} min`,
        warning: true,
      });
    }

    events.sort((a, b) => a.at.getTime() - b.at.getTime());
    return { row, events };
  }

  private async rowById(type: 'sos' | 'journey', id: string): Promise<HistoryRow> {
    const { rows } = await sql<{
      type: 'sos' | 'journey';
      id: string;
      started_at: Date;
      ended_at: Date | null;
      is_test: boolean;
      trigger: string | null;
      user_id: string | null;
      user_name: string | null;
      user_phone: string | null;
      guardians_alerted: string;
      outcome: Outcome;
      sos_id: string | null;
    }>`SELECT * FROM (${ROWS}) h WHERE h.type = ${type} AND h.id = ${id}`.execute(this.database.db);
    const r = rows[0];
    if (!r) throw new NotFoundException('Not found');
    return {
      type: r.type,
      id: r.id,
      cursor: encodeCursor(r.started_at, r.type, r.id),
      startedAt: r.started_at,
      endedAt: r.ended_at,
      isTest: r.is_test,
      trigger: r.trigger,
      user:
        r.type === 'sos' && r.user_id
          ? { id: r.user_id, name: r.user_name, phone: maskPhone(r.user_phone) }
          : null,
      userDeleted: r.type === 'sos' && !r.user_id,
      guardiansAlerted: Number(r.guardians_alerted),
      outcome: r.outcome,
      sosId: r.sos_id,
    };
  }
}
