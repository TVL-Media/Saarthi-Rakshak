import { timingSafeEqual } from 'node:crypto';
import { Body, Controller, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env.schema';
import { DatabaseService } from '../../database/database.module';
import { AppPublic } from '../auth/app-auth.decorators';
import { appError, parseAppBody } from '../common/app-http';

/**
 * Delivery report from an SMS provider. Each real provider gets a small adapter that turns its
 * own format into this one when it is added; until then this is the format.
 */
const DeliveryReport = z.object({
  messageId: z.string().min(1).max(200),
  status: z.enum(['delivered', 'failed']),
  error: z.string().max(300).optional(),
});

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

@Controller('v1/webhooks/sms')
export class DeliveryController {
  constructor(
    private readonly database: DatabaseService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @AppPublic()
  @Post(':provider')
  @HttpCode(204)
  async report(
    @Param('provider') provider: string,
    @Headers('x-webhook-secret') secret: string | undefined,
    @Body() body: unknown,
  ): Promise<void> {
    if (!this.env.SMS_WEBHOOK_SECRET) {
      throw appError.serviceUnavailable('Delivery reports are not set up on this server.');
    }
    if (!secret || !sameSecret(secret, this.env.SMS_WEBHOOK_SECRET)) throw appError.notLoggedIn();
    if (provider !== 'main' && provider !== 'backup') throw appError.notFound();

    const report = parseAppBody(DeliveryReport, body);
    await this.database.db
      .updateTable('alerts')
      .set(
        report.status === 'delivered'
          ? { status: 'delivered', delivered_at: sql<Date>`now()` }
          : { status: 'failed', error: report.error ?? 'Not delivered (provider report).' },
      )
      .where('provider_message_id', '=', report.messageId)
      .where('provider', '=', provider)
      .where('channel', '=', 'sms')
      .execute();
  }
}
