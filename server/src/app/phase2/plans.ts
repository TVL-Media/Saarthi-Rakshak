import { createHash, createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { VerifyPurchaseRequest, type Plan, type PlansReply } from '@sarthi/shared';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env.schema';
import { DatabaseService } from '../../database/database.module';
import { AppPublic } from '../auth/app-auth.decorators';
import { appError, parseAppBody, type AppRequest } from '../common/app-http';
import { AppRateLimiter } from '../common/rate-limit';
import { OutgoingMessages } from '../messages/outgoing-messages';

type PlanRow = {
  id: Plan['id'];
  name: string;
  monthly_price_inr: number | null;
  yearly_price_inr: number | null;
  monthly_product_id: string | null;
  yearly_product_id: string | null;
  features: unknown;
  evidence_storage_mb: number;
  on_sale: boolean;
};

export const toPlan = (r: PlanRow): Plan => ({
  id: r.id,
  name: r.name,
  monthlyPriceInr: r.monthly_price_inr,
  yearlyPriceInr: r.yearly_price_inr,
  monthlyProductId: r.monthly_product_id,
  yearlyProductId: r.yearly_product_id,
  features: Array.isArray(r.features) ? (r.features as string[]) : [],
  evidenceStorageMb: r.evidence_storage_mb,
  onSale: r.on_sale,
});

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** What Google Play says about one subscription purchase. */
export interface PlayState {
  productId: string;
  status: 'active' | 'pending' | 'cancelled' | 'expired' | 'refunded';
  renewsAt: Date | null;
}

/**
 * Asks Google Play about a purchase (Android Publisher API, subscriptionsv2). Needs the
 * service-account key in GOOGLE_PLAY_CREDENTIALS; signs its own token request (no extra library).
 */
@Injectable()
export class GooglePlay {
  private token: { value: string; until: number } | null = null;

  constructor(@Inject(ENV) private readonly env: Env) {}

  get configured(): boolean {
    return Boolean(this.env.GOOGLE_PLAY_PACKAGE_NAME && this.env.GOOGLE_PLAY_CREDENTIALS);
  }

  async check(purchaseToken: string): Promise<PlayState> {
    if (!this.configured) throw appError.serviceUnavailable('Payments are not set up yet.');
    const url =
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
      `${this.env.GOOGLE_PLAY_PACKAGE_NAME}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${await this.accessToken()}` },
    });
    if (res.status === 400 || res.status === 404 || res.status === 410) {
      throw appError.invalidInput('This purchase was not found on Google Play.');
    }
    if (!res.ok) throw appError.serviceUnavailable('Google Play did not answer. Please try again.');
    const body = (await res.json()) as {
      subscriptionState?: string;
      lineItems?: { productId?: string; expiryTime?: string }[];
    };
    const line = body.lineItems?.[0];
    const expiry = line?.expiryTime ? new Date(line.expiryTime) : null;
    const status: PlayState['status'] = (() => {
      switch (body.subscriptionState) {
        case 'SUBSCRIPTION_STATE_ACTIVE':
        case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
          return 'active';
        case 'SUBSCRIPTION_STATE_PENDING':
          return 'pending';
        case 'SUBSCRIPTION_STATE_CANCELED':
          // Cancelled but paid until the expiry time.
          return expiry && expiry > new Date() ? 'active' : 'cancelled';
        default:
          return 'expired';
      }
    })();
    return { productId: line?.productId ?? '', status, renewsAt: expiry };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now() + 60_000) return this.token.value;
    const key = JSON.parse(await readFile(this.env.GOOGLE_PLAY_CREDENTIALS!, 'utf8')) as {
      client_email: string;
      private_key: string;
    };
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(key.private_key)
      .toString('base64url');
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
    });
    if (!res.ok) throw appError.serviceUnavailable('Google Play sign-in failed.');
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, until: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }
}

/**
 * Plans (feature 25). SOS, guardians and live location are never locked. While no plan is on
 * sale, everything is free for everyone (the client has not set prices yet).
 */
@Injectable()
export class PlansService {
  private readonly logger = new Logger('Plans');

  constructor(
    private readonly database: DatabaseService,
    private readonly play: GooglePlay,
    private readonly rateLimiter: AppRateLimiter,
    private readonly messages: OutgoingMessages,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async plans(): Promise<Plan[]> {
    const rows = await this.database.db
      .selectFrom('plans')
      .selectAll()
      .orderBy('sort_order')
      .execute();
    return rows.map(toPlan);
  }

  async forUser(userId: string): Promise<PlansReply> {
    const plans = await this.plans();
    const everythingFree = !plans.some((p) => p.onSale);
    const sub = await this.activeSubscription(userId);
    return {
      plans,
      current: (sub?.plan_id as Plan['id']) ?? 'basic',
      everythingFree,
      renewsAt: sub?.renews_at?.toISOString() ?? null,
    };
  }

  /** The user's evidence storage limit (the biggest plan's while everything is free). */
  async evidenceLimitMb(userId: string): Promise<number> {
    const reply = await this.forUser(userId);
    if (reply.everythingFree) return Math.max(...reply.plans.map((p) => p.evidenceStorageMb), 2048);
    return reply.plans.find((p) => p.id === reply.current)?.evidenceStorageMb ?? 2048;
  }

  private activeSubscription(userId: string) {
    return this.database.db
      .selectFrom('subscriptions')
      .select(['plan_id', 'renews_at'])
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
  }

  /** After a purchase in the app: checks it with Google and saves it. */
  async verify(userId: string, input: VerifyPurchaseRequest): Promise<PlansReply> {
    await this.rateLimiter.check(`plan-verify:${userId}`, 20, 3600);
    const plan = await this.database.db
      .selectFrom('plans')
      .select('id')
      .where((eb) =>
        eb.or([
          eb('monthly_product_id', '=', input.productId),
          eb('yearly_product_id', '=', input.productId),
        ]),
      )
      .executeTakeFirst();
    if (!plan) throw appError.invalidInput('productId: Not one of our plans.');
    const state = await this.play.check(input.purchaseToken);
    if (state.productId && state.productId !== input.productId) {
      throw appError.invalidInput('This purchase is for a different plan.');
    }
    const hash = hashToken(input.purchaseToken);
    const existing = await this.database.db
      .selectFrom('subscriptions')
      .select('user_id')
      .where('purchase_token_hash', '=', hash)
      .executeTakeFirst();
    if (existing && existing.user_id !== userId) {
      throw appError.conflict('This purchase belongs to another account.');
    }
    const values = {
      plan_id: plan.id,
      product_id: input.productId,
      status: state.status,
      renews_at: state.renewsAt,
      cancelled_at: state.status === 'cancelled' ? new Date() : null,
    };
    await this.database.db
      .insertInto('subscriptions')
      .values({ user_id: userId, purchase_token_hash: hash, ...values })
      .onConflict((oc) => oc.column('purchase_token_hash').doUpdateSet(values))
      .execute();
    return this.forUser(userId);
  }

  /**
   * Google Play real-time notification (Cloud Pub/Sub push). The token in the address proves it
   * came through our subscription; the purchase itself is then re-checked with Google.
   */
  async playNotification(token: string | undefined, body: unknown): Promise<void> {
    if (!token || token !== this.env.GOOGLE_PLAY_WEBHOOK_TOKEN) throw appError.notFound();
    const data = (body as { message?: { data?: string } })?.message?.data;
    if (!data) return;
    let note: { subscriptionNotification?: { purchaseToken?: string; notificationType?: number } };
    try {
      note = JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as typeof note;
    } catch {
      return;
    }
    const purchaseToken = note.subscriptionNotification?.purchaseToken;
    if (!purchaseToken) return; // e.g. a test notification
    const hash = hashToken(purchaseToken);
    const sub = await this.database.db
      .selectFrom('subscriptions')
      .select(['id', 'user_id', 'status'])
      .where('purchase_token_hash', '=', hash)
      .executeTakeFirst();
    if (!sub) return; // the app verifies new purchases itself
    // 12 = revoked (refunded), 13 = expired.
    const type = note.subscriptionNotification?.notificationType;
    const state =
      type === 12
        ? { status: 'refunded' as const, renewsAt: null }
        : await this.play.check(purchaseToken).catch((err: Error) => {
            this.logger.error(`Play check failed: ${err.message}`);
            return null;
          });
    if (!state) return;
    await this.database.db
      .updateTable('subscriptions')
      .set({
        status: state.status,
        renews_at: state.renewsAt,
        ...(state.status !== 'active' && sub.status === 'active' && { cancelled_at: new Date() }),
      })
      .where('id', '=', sub.id)
      .execute();
    if (sub.user_id && sub.status === 'active' && state.status !== 'active') {
      await this.messages.notifyUser(
        sub.user_id,
        'plan_status',
        'Your plan has ended',
        'You are back on Basic. SOS, guardians and live location are always free.',
        {},
      );
    }
  }
}

@Controller()
export class PlansController {
  constructor(private readonly plans: PlansService) {}

  @Get('v1/plans')
  get(@Req() req: AppRequest): Promise<PlansReply> {
    return this.plans.forUser(req.user!.id);
  }

  @Post('v1/subscriptions/verify')
  @HttpCode(200)
  verify(@Req() req: AppRequest, @Body() body: unknown): Promise<PlansReply> {
    return this.plans.verify(req.user!.id, parseAppBody(VerifyPurchaseRequest, body));
  }

  @AppPublic()
  @Post('webhooks/google-play')
  @HttpCode(204)
  async google(@Query('token') token: string | undefined, @Body() body: unknown): Promise<void> {
    await this.plans.playNotification(token, body);
  }
}
