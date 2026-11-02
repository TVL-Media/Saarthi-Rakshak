import { Injectable } from '@nestjs/common';
import type {
  AudioClip,
  HistoryDetail,
  HistoryItem,
  HistoryPage,
  HistoryQuery,
  TimelineEntry,
} from '@sarthi/shared';
import { sql } from 'kysely';
import { DatabaseService } from '../../database/database.module';
import { appError } from '../common/app-http';

/** History items per page. */
export const HISTORY_PAGE_SIZE = 20;

type ItemType = HistoryItem['type'];

interface ItemRow {
  type: ItemType;
  id: string;
  status: string;
  is_test: boolean;
  trigger: string | null;
  destination_label: string | null;
  started_at: Date;
  ended_at: Date | null;
  /** started_at in microseconds (exact, for the page cursor). */
  started_us: string;
}

interface Cursor {
  us: string;
  type: ItemType;
  id: string;
}

const encodeCursor = (c: Cursor) =>
  Buffer.from(JSON.stringify([c.us, c.type, c.id])).toString('base64url');

function decodeCursor(text: string): Cursor {
  try {
    const [us, type, id] = JSON.parse(Buffer.from(text, 'base64url').toString()) as unknown[];
    if (
      typeof us === 'string' &&
      /^\d{1,20}$/.test(us) &&
      (type === 'sos' || type === 'journey') &&
      typeof id === 'string' &&
      /^[0-9a-f-]{36}$/i.test(id)
    ) {
      return { us, type, id };
    }
  } catch {
    // falls through
  }
  throw appError.invalidInput('cursor: Not a valid page cursor.');
}

const toItem = (r: ItemRow): HistoryItem => ({
  type: r.type,
  id: r.id,
  status: r.status,
  isTest: r.is_test,
  trigger: r.trigger,
  destinationLabel: r.destination_label,
  startedAt: r.started_at.toISOString(),
  endedAt: r.ended_at ? r.ended_at.toISOString() : null,
});

const CHECKIN_REASON: Record<string, string> = {
  stopped: 'stopped for too long',
  off_route: 'off the route',
  late: 'running late',
};

const CHECKIN_ANSWER: Record<string, string> = {
  fine: 'You answered “I’m fine”',
  traffic_pause: 'You answered “Stuck in traffic”',
  sos: 'You answered “I need help”',
  no_reply: 'No reply to the check-in',
};

/** The user's own past SOS events and journeys (History tab). */
@Injectable()
export class HistoryService {
  constructor(private readonly database: DatabaseService) {}

  async list(userId: string, query: HistoryQuery): Promise<HistoryPage> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const { rows } = await sql<ItemRow>`
      SELECT * FROM (
        SELECT 'sos' AS type, id, status, is_test, trigger, NULL::text AS destination_label,
               started_at, ended_at,
               floor(extract(epoch FROM started_at) * 1000000)::bigint::text AS started_us
          FROM sos_events WHERE user_id = ${userId}
        UNION ALL
        SELECT 'journey' AS type, id, status, false, NULL::text, destination_label,
               started_at, ended_at,
               floor(extract(epoch FROM started_at) * 1000000)::bigint::text
          FROM journeys WHERE user_id = ${userId}
      ) h
      WHERE ${query.type ? sql`h.type = ${query.type}` : sql`true`}
        AND ${
          cursor
            ? sql`(h.started_us::bigint, h.type, h.id) < (${cursor.us}::bigint, ${cursor.type}, ${cursor.id}::uuid)`
            : sql`true`
        }
      ORDER BY h.started_us::bigint DESC, h.type DESC, h.id DESC
      LIMIT ${HISTORY_PAGE_SIZE + 1}
    `.execute(this.database.db);

    const page = rows.slice(0, HISTORY_PAGE_SIZE);
    const last = page.at(-1);
    return {
      items: page.map(toItem),
      nextCursor:
        rows.length > HISTORY_PAGE_SIZE && last
          ? encodeCursor({ us: last.started_us, type: last.type, id: last.id })
          : null,
    };
  }

  async sos(userId: string, id: string): Promise<HistoryDetail> {
    const db = this.database.db;
    const sos = await db
      .selectFrom('sos_events')
      .select(['id', 'status', 'is_test', 'trigger', 'started_at', 'ended_at'])
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!sos) throw appError.notFound('SOS not found.');

    const item = toItem({
      ...sos,
      type: 'sos',
      started_at: new Date(sos.started_at),
      destination_label: null,
      started_us: '0',
    });
    const timeline: TimelineEntry[] = [];
    const at = (d: Date | string) => new Date(d).toISOString();

    if (sos.status === 'cancelled') {
      timeline.push({
        at: at(sos.started_at),
        kind: 'sos_cancelled',
        text: 'SOS cancelled in the countdown. Nothing was sent.',
      });
    } else {
      timeline.push({
        at: at(sos.started_at),
        kind: 'sos_started',
        text: sos.is_test ? 'Test SOS sent' : 'SOS started',
      });
      timeline.push(...(await this.linkEntries('sos_event_id', id, sos.is_test)));
      if (sos.ended_at && !sos.is_test) {
        timeline.push({
          at: at(sos.ended_at),
          kind: 'sos_ended',
          text: 'You marked yourself safe',
        });
      }
    }

    const clips = await db
      .selectFrom('media_clips')
      .select(['id', 'recorded_at', 'created_at', 'duration_s', 'keep', 'delete_after'])
      .where('sos_event_id', '=', id)
      .where('user_id', '=', userId)
      .where('deleted_at', 'is', null)
      .orderBy(sql`coalesce(recorded_at, created_at)`)
      .execute();

    return {
      item,
      timeline: sortTimeline(timeline),
      clips: clips.map((c): AudioClip => ({
        id: c.id,
        recordedAt: (c.recorded_at ?? c.created_at).toISOString(),
        durationS: c.duration_s,
        keep: c.keep,
        deleteAfter: at(c.delete_after),
      })),
    };
  }

  async journey(userId: string, id: string): Promise<HistoryDetail> {
    const db = this.database.db;
    const journey = await db
      .selectFrom('journeys')
      .select(['id', 'status', 'destination_label', 'started_at', 'ended_at'])
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!journey) throw appError.notFound('Journey not found.');

    const place = journey.destination_label ?? 'your destination';
    const at = (d: Date | string) => new Date(d).toISOString();
    const timeline: TimelineEntry[] = [
      { at: at(journey.started_at), kind: 'journey_started', text: `Journey to ${place} started` },
      ...(await this.linkEntries('journey_id', id, false)),
    ];

    const checkins = await db
      .selectFrom('checkins')
      .select(['reason', 'status', 'asked_at', 'answered_at'])
      .where('journey_id', '=', id)
      .execute();
    for (const c of checkins) {
      timeline.push({
        at: at(c.asked_at),
        kind: 'checkin',
        text: `Check-in: ${CHECKIN_REASON[c.reason] ?? c.reason}`,
      });
      if (c.status !== 'pending') {
        timeline.push({
          at: at(c.answered_at ?? c.asked_at),
          kind: 'checkin_answered',
          text: CHECKIN_ANSWER[c.status] ?? c.status,
        });
      }
    }

    const soses = await db
      .selectFrom('sos_events')
      .select(['started_at', 'status'])
      .where('journey_id', '=', id)
      .where('user_id', '=', userId)
      .where('status', '!=', 'cancelled')
      .execute();
    for (const s of soses) {
      timeline.push({ at: at(s.started_at), kind: 'sos_started', text: 'SOS started' });
    }

    if (journey.ended_at) {
      const text =
        journey.status === 'arrived'
          ? `You reached ${place} safely`
          : journey.status === 'lost_contact'
            ? 'Lost contact with your phone'
            : 'Journey ended';
      timeline.push({ at: at(journey.ended_at), kind: 'journey_ended', text });
    }

    return {
      item: toItem({
        ...journey,
        type: 'journey',
        is_test: false,
        trigger: null,
        started_us: '0',
      }),
      timeline: sortTimeline(timeline),
      clips: [],
    };
  }

  /** "Alert sent to Ravi", "Ravi opened the live link", "Ravi is responding". */
  private async linkEntries(
    column: 'sos_event_id' | 'journey_id',
    id: string,
    isTest: boolean,
  ): Promise<TimelineEntry[]> {
    const links = await this.database.db
      .selectFrom('guardian_links as l')
      .innerJoin('guardians as g', 'g.id', 'l.guardian_id')
      .select(['g.name', 'l.created_at', 'l.opened_at', 'l.responding_at'])
      .where(`l.${column}`, '=', id)
      .execute();
    const sent =
      column === 'journey_id'
        ? 'Journey link sent to'
        : isTest
          ? 'Test alert sent to'
          : 'Alert sent to';
    const entries: TimelineEntry[] = [];
    for (const l of links) {
      entries.push({
        at: l.created_at.toISOString(),
        kind: 'guardian_alerted',
        text: `${sent} ${l.name}`,
      });
      if (l.opened_at) {
        entries.push({
          at: l.opened_at.toISOString(),
          kind: 'link_opened',
          text: `${l.name} opened the live link`,
        });
      }
      if (l.responding_at) {
        entries.push({
          at: l.responding_at.toISOString(),
          kind: 'guardian_responding',
          text: `${l.name} is responding`,
        });
      }
    }
    return entries;
  }
}

/** Oldest first; entries at the same moment keep the order they were added in. */
function sortTimeline(entries: TimelineEntry[]): TimelineEntry[] {
  return entries
    .map((e, i) => ({ e, i, t: Date.parse(e.at) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.e);
}
