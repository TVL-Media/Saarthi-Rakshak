import { Injectable, Logger } from '@nestjs/common';
import { maskPhone } from '../../users/phone';

export interface OutgoingSms {
  /** Which guardian it is for (kept in place of the number). */
  guardianId: string;
  kind: 'invite' | 'sos' | 'sos_link' | 'safe' | 'test';
  text: string;
}

/**
 * Messages the server sends to guardians. Until Part B (real SMS providers and the job queue),
 * messages are only printed in the server console, with the number masked. Tests read `sent`.
 */
@Injectable()
export class OutgoingMessages {
  private readonly logger = new Logger('SMS (not sent: log only)');
  /** Every message since the server started; for tests. */
  readonly sent: OutgoingSms[] = [];

  sendSms(phone: string, sms: OutgoingSms): Promise<void> {
    this.sent.push(sms);
    this.logger.log(`to ${maskPhone(phone)} [${sms.kind}] ${sms.text}`);
    return Promise.resolve();
  }
}
