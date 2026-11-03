import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { GUARDIAN_NUMBER, guardianLabel } from '../alerts/guardian-label';
import { DatabaseService } from '../database/database.module';
import { DEFAULT_SETTINGS } from '../settings/default-settings';
import { maskPhone } from '../users/phone';

export interface LiveSosRow {
  id: string;
  startedAt: Date;
  isTest: boolean;
  trigger: string;
  /** Masked phone only: the list never shows a name. */
  phone: string | null;
  lastLocationAt: Date | null;
  lostContact: boolean;
  anyoneResponding: boolean;
}

export interface LiveGuardian {
  /** "Guardian 1 (brother) +91 98•• ••0001" */
  label: string;
  sms: 'queued' | 'sent' | 'delivered' | 'failed' | null;
  /** Push is never "delivered": Firebase gives no reliable delivery report. */
  push: 'queued' | 'sent' | 'failed' | null;
  openedAt: Date | null;
  respondingAt: Date | null;
}

export type LiveSosDetails =
  | {
      ended: false;
      id: string;
      startedAt: Date;
      isTest: boolean;
      trigger: string;
      user: { id: string; name: string | null; phone: string | null } | null;
      /** Never coordinates: only when the last location came in and how accurate it was. */
      lastLocation: { at: Date; accuracyM: number | null } | null;
      battery: number | null;
      network: string | null;
      lostContact: boolean;
      lostContactMinutes: number;
      guardians: LiveGuardian[];
      audio: { clips: number };
    }
  | { ended: true; id: string; outcome: 'ended_safe' | 'cancelled'; endedAt: Date | null };

@Injectable()
export class LiveSosService {
  constructor(private readonly database: DatabaseService) {}

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

  /**
   * Active SOS: those with lost contact or no guardian responding first, then the longest
   * running; TEST SOS last.
   */
  async list(): Promise<LiveSosRow[]> {
    const lostMinutes = await this.lostContactMinutes();
    const { rows } = await sql<{
      id: string;
      started_at: Date;
      is_test: boolean;
      trigger: string;
      phone: string | null;
      last_location_at: Date | null;
      lost_contact: boolean;
      anyone_responding: boolean;
    }>`
      SELECT s.id, s.started_at, s.is_test, s.trigger, u.phone,
             p.last_location_at,
             coalesce(p.last_location_at, s.started_at) < now() - make_interval(mins => ${lostMinutes}) AS lost_contact,
             EXISTS (SELECT 1 FROM guardian_links l WHERE l.sos_event_id = s.id AND l.responding_at IS NOT NULL) AS anyone_responding
      FROM sos_events s
      LEFT JOIN users u ON u.id = s.user_id
      LEFT JOIN LATERAL (SELECT max(recorded_at) AS last_location_at FROM location_points WHERE sos_event_id = s.id) p ON true
      WHERE s.status = 'active'
    `.execute(this.database.db);

    const urgent = (r: (typeof rows)[number]) => r.lost_contact || !r.anyone_responding;
    rows.sort(
      (a, b) =>
        Number(a.is_test) - Number(b.is_test) ||
        Number(urgent(b)) - Number(urgent(a)) ||
        a.started_at.getTime() - b.started_at.getTime(),
    );
    return rows.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      isTest: r.is_test,
      trigger: r.trigger,
      phone: maskPhone(r.phone),
      lastLocationAt: r.last_location_at,
      lostContact: r.lost_contact,
      anyoneResponding: r.anyone_responding,
    }));
  }

  /** One SOS. If it is no longer active, only how it ended (live details are not shown). */
  async details(id: string): Promise<LiveSosDetails | null> {
    const db = this.database.db;
    const sos = await db
      .selectFrom('sos_events as s')
      .leftJoin('users as u', 'u.id', 's.user_id')
      .select([
        's.id',
        's.status',
        's.started_at',
        's.ended_at',
        's.is_test',
        's.trigger',
        'u.id as user_id',
        'u.name',
        'u.phone',
      ])
      .where('s.id', '=', id)
      .executeTakeFirst();
    if (!sos) return null;
    if (sos.status !== 'active') {
      return {
        ended: true,
        id,
        outcome: sos.status === 'cancelled' ? 'cancelled' : 'ended_safe',
        endedAt: sos.ended_at,
      };
    }

    const lostMinutes = await this.lostContactMinutes();
    const last = await db
      .selectFrom('location_points')
      .select(['recorded_at', 'accuracy_m', 'battery_pct', 'network'])
      .where('sos_event_id', '=', id)
      .orderBy('recorded_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    const lastAt = last ? new Date(last.recorded_at) : null;
    const lostContact =
      (lastAt ?? new Date(sos.started_at)).getTime() < Date.now() - lostMinutes * 60_000;

    // Every guardian of the user (accepted or alerted), with this SOS's latest alert per channel.
    const { rows: guardians } = await sql<{
      number: number;
      relation: string | null;
      phone: string | null;
      sms: LiveGuardian['sms'];
      push: 'queued' | 'sent' | 'delivered' | 'failed' | null;
      opened_at: Date | null;
      responding_at: Date | null;
    }>`
      SELECT ${GUARDIAN_NUMBER} AS number, g.relation, g.phone,
        (SELECT a.status FROM alerts a WHERE a.sos_event_id = ${id} AND a.guardian_id = g.id
           AND a.channel IN ('sms', 'sim_sms') ORDER BY a.created_at DESC LIMIT 1) AS sms,
        (SELECT a.status FROM alerts a WHERE a.sos_event_id = ${id} AND a.guardian_id = g.id
           AND a.channel = 'push' ORDER BY a.created_at DESC LIMIT 1) AS push,
        (SELECT min(l.opened_at) FROM guardian_links l WHERE l.sos_event_id = ${id} AND l.guardian_id = g.id) AS opened_at,
        (SELECT min(l.responding_at) FROM guardian_links l WHERE l.sos_event_id = ${id} AND l.guardian_id = g.id) AS responding_at
      FROM guardians g
      WHERE g.user_id = ${sos.user_id}
        AND (g.invite_status = 'accepted'
             OR EXISTS (SELECT 1 FROM alerts a WHERE a.sos_event_id = ${id} AND a.guardian_id = g.id))
      ORDER BY number
    `.execute(db);

    const clips = await db
      .selectFrom('media_clips')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('sos_event_id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();

    return {
      ended: false,
      id,
      startedAt: new Date(sos.started_at),
      isTest: sos.is_test,
      trigger: sos.trigger,
      user: sos.user_id
        ? { id: sos.user_id, name: sos.name, phone: maskPhone(sos.phone ?? null) }
        : null,
      lastLocation: last && lastAt ? { at: lastAt, accuracyM: last.accuracy_m } : null,
      battery: last?.battery_pct ?? null,
      network: last?.network ?? null,
      lostContact,
      lostContactMinutes: lostMinutes,
      guardians: guardians.map((g) => ({
        label: guardianLabel(g),
        sms: g.sms,
        push: g.push === 'delivered' ? 'sent' : g.push,
        openedAt: g.opened_at,
        respondingAt: g.responding_at,
      })),
      audio: { clips: Number(clips.n) },
    };
  }
}
