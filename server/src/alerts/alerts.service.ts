import { BadRequestException, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.module';
import { MAX_SMS_ATTEMPTS } from './alerts.constants';
import { GUARDIAN_NUMBER, guardianLabel } from './guardian-label';

export const ALERTS_PAGE_SIZE = 50;

/** What happens next for one message (the panel turns this into words). */
export type NextStep =
  | 'sending' // waiting to send
  | 'awaiting_report' // SMS sent, no delivery report yet
  | 'none' // delivered, or a push that was sent
  | 'retry_backup' // failed on the main provider
  | 'retrying' // failed on the backup provider, tries left
  | 'all_failed' // no tries left (needs attention)
  | 'sent_again' // fixed by a later try
  | 'sms_sent_too' // failed push, but an SMS reached the same guardian
  | 'no_sms_yet'; // failed push, and no SMS has been sent to that guardian

export interface AlertRow {
  id: string;
  cursor: string;
  at: Date;
  channel: 'sms' | 'push' | 'sim_sms';
  provider: 'main' | 'backup' | null;
  /** Push is never "delivered": Firebase gives no reliable delivery report. */
  result: 'queued' | 'sent' | 'delivered' | 'failed';
  attempt: number;
  maxAttempts: number;
  /** "Guardian 1 (brother) +91 98•• ••0001". The user is never named here. */
  to: string;
  about: { type: 'sos' | 'journey'; id: string } | null;
  stillFailed: boolean;
  nextStep: NextStep;
}

export interface AlertCounts {
  sentToday: number;
  deliveredToday: number;
  failedToday: number;
  backupToday: number;
}

/**
 * Every alert with two computed facts: fixed_later (a later try of the same channel to the same
 * guardian for the same SOS/journey went out) and sms_ok (an SMS reached that guardian too).
 */
const ALERTS = sql`
  SELECT a.*,
         EXISTS (
           SELECT 1 FROM alerts b
           WHERE b.guardian_id IS NOT DISTINCT FROM a.guardian_id
             AND b.sos_event_id IS NOT DISTINCT FROM a.sos_event_id
             AND b.journey_id IS NOT DISTINCT FROM a.journey_id
             AND b.channel = a.channel
             AND b.status IN ('sent', 'delivered')
             AND (b.created_at, b.id) > (a.created_at, a.id)
         ) AS fixed_later,
         EXISTS (
           SELECT 1 FROM alerts b
           WHERE b.guardian_id IS NOT DISTINCT FROM a.guardian_id
             AND b.sos_event_id IS NOT DISTINCT FROM a.sos_event_id
             AND b.journey_id IS NOT DISTINCT FROM a.journey_id
             AND b.channel IN ('sms', 'sim_sms')
             AND b.status IN ('sent', 'delivered')
         ) AS sms_ok
  FROM alerts a
`;

function nextStepOf(r: {
  channel: string;
  provider: string | null;
  status: string;
  attempt: number;
  fixed_later: boolean;
  sms_ok: boolean;
}): NextStep {
  if (r.status === 'queued') return 'sending';
  if (r.channel === 'push') {
    if (r.status !== 'failed') return 'none';
    return r.sms_ok ? 'sms_sent_too' : 'no_sms_yet';
  }
  if (r.status === 'delivered') return 'none';
  if (r.status === 'sent') return r.channel === 'sms' ? 'awaiting_report' : 'none';
  // Failed.
  if (r.fixed_later) return 'sent_again';
  if (r.channel !== 'sms') return 'none';
  if (r.provider === 'main') return 'retry_backup';
  return r.attempt < MAX_SMS_ATTEMPTS ? 'retrying' : 'all_failed';
}

function encodeCursor(stillFailed: boolean, at: Date, id: string): string {
  return Buffer.from(`${stillFailed ? 1 : 0}|${at.toISOString()}|${id}`).toString('base64url');
}

@Injectable()
export class AlertsService {
  constructor(private readonly database: DatabaseService) {}

  /** Today's numbers (India day). */
  async counts(): Promise<AlertCounts> {
    const { rows } = await sql<{ sent: string; delivered: string; failed: string; backup: string }>`
      SELECT count(*) FILTER (WHERE a.status IN ('sent', 'delivered')) AS sent,
             count(*) FILTER (WHERE a.status = 'delivered' AND a.channel <> 'push') AS delivered,
             count(*) FILTER (WHERE a.status = 'failed' AND NOT a.fixed_later) AS failed,
             count(*) FILTER (WHERE a.provider = 'backup' AND a.status IN ('sent', 'delivered')) AS backup
      FROM (${ALERTS}) a
      WHERE a.created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
    `.execute(this.database.db);
    const r = rows[0];
    return {
      sentToday: Number(r.sent),
      deliveredToday: Number(r.delivered),
      failedToday: Number(r.failed),
      backupToday: Number(r.backup),
    };
  }

  /** Failures not fixed by a later try first, then newest first. 50 per page. Read-only. */
  async list(before?: string): Promise<{ rows: AlertRow[]; more: boolean }> {
    let after = sql`true`;
    if (before) {
      const [flag, iso, id] = Buffer.from(before, 'base64url').toString().split('|');
      if (!['0', '1'].includes(flag) || Number.isNaN(Date.parse(iso ?? '')) || !id) {
        throw new BadRequestException('Invalid page');
      }
      after = sql`(x.still_failed::int, x.created_at, x.id::text) < (${Number(flag)}, ${iso}::timestamptz, ${id})`;
    }

    const { rows } = await sql<{
      id: string;
      created_at: Date;
      sent_at: Date | null;
      channel: 'sms' | 'push' | 'sim_sms';
      provider: 'main' | 'backup' | null;
      status: 'queued' | 'sent' | 'delivered' | 'failed';
      attempt: number;
      sos_event_id: string | null;
      journey_id: string | null;
      fixed_later: boolean;
      sms_ok: boolean;
      still_failed: boolean;
      g_number: number | null;
      g_relation: string | null;
      g_phone: string | null;
      g_exists: boolean;
    }>`
      SELECT x.* FROM (
        SELECT a.*, (a.status = 'failed' AND NOT a.fixed_later) AS still_failed,
               ${GUARDIAN_NUMBER} AS g_number, g.relation AS g_relation, g.phone AS g_phone,
               g.id IS NOT NULL AS g_exists
        FROM (${ALERTS}) a LEFT JOIN guardians g ON g.id = a.guardian_id
      ) x
      WHERE ${after}
      ORDER BY x.still_failed DESC, x.created_at DESC, x.id::text DESC
      LIMIT ${ALERTS_PAGE_SIZE + 1}
    `.execute(this.database.db);

    return {
      more: rows.length > ALERTS_PAGE_SIZE,
      rows: rows.slice(0, ALERTS_PAGE_SIZE).map((r) => ({
        id: r.id,
        cursor: encodeCursor(r.still_failed, r.created_at, r.id),
        at: r.sent_at ?? r.created_at,
        channel: r.channel,
        provider: r.provider,
        result: r.channel === 'push' && r.status === 'delivered' ? 'sent' : r.status,
        attempt: r.attempt,
        maxAttempts: MAX_SMS_ATTEMPTS,
        to: guardianLabel(
          r.g_exists ? { number: r.g_number ?? 0, relation: r.g_relation, phone: r.g_phone } : null,
        ),
        about: r.sos_event_id
          ? { type: 'sos', id: r.sos_event_id }
          : r.journey_id
            ? { type: 'journey', id: r.journey_id }
            : null,
        stillFailed: r.still_failed,
        nextStep: nextStepOf(r),
      })),
    };
  }
}
