import { Logger } from '@nestjs/common';
import type { App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { Env } from '../../config/env.schema';
import { firebaseApp } from '../auth/firebase-app';

/** Kinds of push notification the app handles (see docs/app-api.md). */
export type PushType =
  | 'guardian_status'
  | 'show_call_112'
  | 'checkin_no_reply'
  | 'community_status'
  | 'rakshak_status'
  | 'plan_status'
  | 'booking_status'
  | 'partner_request_status'
  | 'child_alert'
  | 'child_link'
  | 'monitoring_session'
  | 'school_event'
  | 'cyber_flag';

export interface PushMessage {
  type: PushType;
  title: string;
  body: string;
  /** Extra values for the app, e.g. { sosId }. */
  data: Record<string, string>;
}

export type PushResult = 'sent' | 'invalid_token';

/** Push notifications to the user's own phone (Firebase Cloud Messaging). */
export abstract class PushSender {
  abstract send(token: string, message: PushMessage): Promise<PushResult>;

  static fromEnv(env: Env): PushSender {
    if (env.NODE_ENV === 'test') return new TestPushSender();
    const app = firebaseApp(env);
    return app ? new FirebasePushSender(app) : new LogPushSender();
  }
}

export class FirebasePushSender extends PushSender {
  constructor(private readonly app: App) {
    super();
  }

  async send(token: string, message: PushMessage): Promise<PushResult> {
    try {
      await getMessaging(this.app).send({
        token,
        data: { type: message.type, ...message.data },
        notification: { title: message.title, body: message.body },
        android: { priority: 'high', notification: { channelId: 'safety_alerts' } },
      });
      return 'sent';
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      ) {
        return 'invalid_token';
      }
      throw err;
    }
  }
}

/** Without Firebase (local): prints the notification. */
export class LogPushSender extends PushSender {
  private readonly logger = new Logger('Push (log only, not sent)');

  send(_token: string, message: PushMessage): Promise<PushResult> {
    this.logger.log(`[${message.type}] ${message.title}: ${message.body}`);
    return Promise.resolve('sent');
  }
}

/** For automated tests: records notifications. */
export class TestPushSender extends PushSender {
  readonly sent: { token: string; message: PushMessage }[] = [];
  invalidTokens = new Set<string>();

  send(token: string, message: PushMessage): Promise<PushResult> {
    if (this.invalidTokens.has(token)) return Promise.resolve('invalid_token');
    this.sent.push({ token, message });
    return Promise.resolve('sent');
  }
}
