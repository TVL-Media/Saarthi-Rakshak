import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { sql } from 'kysely';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env.schema';
import { DatabaseService } from '../../database/database.module';
import type { AlertsTable } from '../../database/types';
import { maskPhone } from '../../users/phone';
import { PushSender, type PushMessage, type PushType } from '../alerts/push-sender';
import { SmsProviders } from '../alerts/sms-providers';
import { JobHandlers, JobQueue } from '../jobs/job-queue';
import { MAX_SMS_ATTEMPTS } from '../../alerts/alerts.constants';

export type SmsKind = AlertsTable['type'];

export interface OutgoingSms {
  /** Which guardian it is for (the number is read from the guardian when sending). */
  guardianId: string;
  kind: SmsKind;
  text: string;
  sosId?: string | null;
  journeyId?: string | null;
}

/** When each try happens after the one before failed. */
interface Step {
  provider: 'main' | 'backup';
  delayMs: number;
}
// Cut to MAX_SMS_ATTEMPTS (the one number the admin Alert Log also reads).
const WITH_BACKUP: Step[] = [
  { provider: 'main', delayMs: 0 },
  { provider: 'backup', delayMs: 0 },
  { provider: 'main', delayMs: 30_000 },
  { provider: 'backup', delayMs: 120_000 },
].slice(0, MAX_SMS_ATTEMPTS) as Step[];
const MAIN_ONLY: Step[] = [
  { provider: 'main', delayMs: 0 },
  { provider: 'main', delayMs: 30_000 },
  { provider: 'main', delayMs: 120_000 },
].slice(0, MAX_SMS_ATTEMPTS) as Step[];

/** An alert still "queued" this long after it was made is put on the queue again. */
export const STUCK_ALERT_MINUTES = 5;

/**
 * Messages to guardians (SMS) and to the user's own phone (push). Every SMS is an `alerts` row per
 * try and a background job, MAX_SMS_ATTEMPTS tries: main → backup → main after 30 s
 * (without a backup provider: main, again after 30 s and 2 min).
 */
@Injectable()
export class OutgoingMessages implements OnModuleInit {
  private readonly logger = new Logger('Messages');
  /** Automated tests only: every SMS asked for since the server started. */
  readonly sent: OutgoingSms[] = [];
  /** Automated tests only: every push asked for. */
  readonly pushed: (PushMessage & { userId: string })[] = [];

  constructor(
    private readonly database: DatabaseService,
    private readonly jobs: JobQueue,
    private readonly handlers: JobHandlers,
    private readonly providers: SmsProviders,
    private readonly push: PushSender,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    this.handlers.register('sms', (data) => this.processSms(String(data.alertId)));
    this.handlers.register('push', (data) => this.processPush(data));
  }

  /** Saves the alert and queues it. Never throws for a queue problem: the sweep re-queues it. */
  async sendSms(_phone: string, sms: OutgoingSms): Promise<void> {
    if (this.env.NODE_ENV === 'test') this.sent.push(sms);
    const alert = await this.database.db
      .insertInto('alerts')
      .values({
        guardian_id: sms.guardianId,
        sos_event_id: sms.sosId ?? null,
        journey_id: sms.journeyId ?? null,
        channel: 'sms',
        provider: 'main',
        type: sms.kind,
        attempt: 1,
        body: sms.text,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await this.queueSms(alert.id, 0);
  }

  /** A push notification to the user's newest phone. */
  async notifyUser(
    userId: string,
    type: PushType,
    title: string,
    body: string,
    data: Record<string, string> = {},
  ): Promise<void> {
    if (this.env.NODE_ENV === 'test') this.pushed.push({ userId, type, title, body, data });
    try {
      await this.jobs.add('push', { userId, type, title, body, data });
    } catch (err) {
      this.logger.error(`Push not queued: ${(err as Error).message}`);
    }
  }

  /** Re-queues alerts that never got onto the queue (e.g. Redis was down). Run by the sweep. */
  async requeueStuck(): Promise<number> {
    const stuck = await this.database.db
      .selectFrom('alerts')
      .select('id')
      .where('status', '=', 'queued')
      .where('channel', '=', 'sms')
      .where('body', 'is not', null)
      .where('created_at', '<', sql<Date>`now() - make_interval(mins => ${STUCK_ALERT_MINUTES})`)
      .limit(200)
      .execute();
    for (const a of stuck) await this.queueSms(a.id, 0);
    return stuck.length;
  }

  private async queueSms(alertId: string, delayMs: number): Promise<void> {
    try {
      await this.jobs.add('sms', { alertId }, { delayMs, jobId: `sms-${alertId}` });
    } catch (err) {
      this.logger.error(`SMS ${alertId} not queued yet: ${(err as Error).message}`);
    }
  }

  /** Sends one try of one SMS. */
  async processSms(alertId: string): Promise<void> {
    const db = this.database.db;
    const alert = await db
      .selectFrom('alerts as a')
      .leftJoin('guardians as g', 'g.id', 'a.guardian_id')
      .select([
        'a.id',
        'a.status',
        'a.body',
        'a.provider',
        'a.attempt',
        'a.type',
        'a.guardian_id',
        'a.sos_event_id',
        'a.journey_id',
        'g.phone',
      ])
      .where('a.id', '=', alertId)
      .executeTakeFirst();
    if (!alert || alert.status !== 'queued' || !alert.body) return;

    if (!alert.phone) {
      await db
        .updateTable('alerts')
        .set({ status: 'failed', error: 'The guardian has no phone number any more.', body: null })
        .where('id', '=', alert.id)
        .execute();
      return;
    }

    const provider =
      alert.provider === 'backup' && this.providers.backup
        ? this.providers.backup
        : this.providers.main;
    try {
      const messageId = await provider.send(alert.phone, alert.body);
      await db
        .updateTable('alerts')
        .set({
          status: 'sent',
          sent_at: sql<Date>`now()`,
          provider_message_id: messageId,
          body: null,
        })
        .where('id', '=', alert.id)
        .where('status', '=', 'queued')
        .execute();
    } catch (err) {
      const steps = this.providers.backup ? WITH_BACKUP : MAIN_ONLY;
      const next = steps[alert.attempt]; // attempt is 1-based: steps[attempt] is the next try
      const reason = ((err as Error).message || 'Provider error').slice(0, 300);
      this.logger.warn(
        `SMS try ${alert.attempt} (${alert.provider}) to ${maskPhone(alert.phone)} failed: ${reason}`,
      );

      let nextId: string | null = null;
      if (next) {
        const row = await db
          .insertInto('alerts')
          .values({
            guardian_id: alert.guardian_id,
            sos_event_id: alert.sos_event_id,
            journey_id: alert.journey_id,
            channel: 'sms',
            provider: next.provider,
            type: alert.type,
            attempt: alert.attempt + 1,
            body: alert.body,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        nextId = row.id;
      }
      await db
        .updateTable('alerts')
        .set({
          status: 'failed',
          sent_at: sql<Date>`now()`,
          error: next ? reason : `${reason} All tries failed.`,
          body: null,
        })
        .where('id', '=', alert.id)
        .execute();
      if (nextId && next) await this.queueSms(nextId, next.delayMs);
    }
  }

  private async processPush(data: Record<string, unknown>): Promise<void> {
    const userId = String(data.userId);
    const device = await this.database.db
      .selectFrom('devices')
      .select(['id', 'push_token'])
      .where('user_id', '=', userId)
      .where('push_token', 'is not', null)
      .orderBy('updated_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!device?.push_token) return; // notifications off or no phone yet

    const result = await this.push.send(device.push_token, {
      type: data.type as PushType,
      title: String(data.title),
      body: String(data.body),
      data: (data.data as Record<string, string> | undefined) ?? {},
    });
    if (result === 'invalid_token') {
      await this.database.db
        .updateTable('devices')
        .set({ push_token: null })
        .where('id', '=', device.id)
        .execute();
    }
  }
}
