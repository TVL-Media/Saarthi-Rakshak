import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Env } from '../../config/env.schema';
import { maskPhone } from '../../users/phone';

/** One SMS company (DLT registered). Real providers are added once the client picks them. */
export interface SmsProvider {
  readonly name: string;
  /** Sends one SMS; returns the provider's message id. Throws if the provider refused it. */
  send(phone: string, text: string): Promise<string>;
}

/** Development only: prints the message (number masked) instead of sending it. */
export class LogSmsProvider implements SmsProvider {
  private readonly logger: Logger;

  constructor(readonly name: string) {
    this.logger = new Logger(`SMS ${name} (log only, not sent)`);
  }

  send(phone: string, text: string): Promise<string> {
    this.logger.log(`to ${maskPhone(phone)}: ${text}`);
    return Promise.resolve(`log-${randomUUID()}`);
  }
}

/** For automated tests: records messages and can be told to fail. */
export class TestSmsProvider implements SmsProvider {
  readonly sent: { phone: string; text: string; messageId: string }[] = [];
  /** While true, every send throws. */
  failing = false;

  constructor(readonly name: string) {}

  send(phone: string, text: string): Promise<string> {
    if (this.failing) return Promise.reject(new Error(`${this.name} provider is down`));
    const messageId = `${this.name}-${randomUUID()}`;
    this.sent.push({ phone, text, messageId });
    return Promise.resolve(messageId);
  }
}

/** The main SMS provider and the backup (if any). */
export class SmsProviders {
  constructor(
    readonly main: SmsProvider,
    readonly backup: SmsProvider | null,
  ) {}

  static fromEnv(env: Env): SmsProviders {
    if (env.NODE_ENV === 'test') {
      return new SmsProviders(new TestSmsProvider('main'), new TestSmsProvider('backup'));
    }
    const make = (kind: 'log', name: string): SmsProvider => {
      if (env.NODE_ENV === 'production') {
        throw new Error(
          `SMS_${name.toUpperCase()}_PROVIDER=${kind} only prints messages and cannot be used in production.`,
        );
      }
      return new LogSmsProvider(name);
    };
    return new SmsProviders(
      make(env.SMS_MAIN_PROVIDER, 'main'),
      env.SMS_BACKUP_PROVIDER === 'none' ? null : make(env.SMS_BACKUP_PROVIDER, 'backup'),
    );
  }
}
