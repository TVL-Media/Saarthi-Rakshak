import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { AreaName, PostCategory } from '@sarthi/shared';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { Roles } from '../../auth/auth.decorators';
import { parseBody, type HttpRequest } from '../../common/http';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env.schema';
import { DatabaseService } from '../../database/database.module';
import { StorageService } from '../../storage/storage.module';
import { OutgoingMessages } from '../messages/outgoing-messages';
import { toPlan } from './plans';
import { unlockDetails } from './rakshak';

const DOC_LINK_SECONDS = 300;
const PHOTO_LINK_SECONDS = 900;
const PAGE = 50;

const reason = z
  .string()
  .trim()
  .min(5, { error: 'Write a reason (at least 5 characters)' })
  .max(500);

const postsQuery = z.object({
  status: z.enum(['pending', 'published', 'rejected', 'removed']).default('pending'),
  before: z.iso.datetime({ offset: true }).optional(),
});
const moderate = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('approve'),
    // "Edit then approve": fix wording; never add personal details.
    body: z.string().trim().min(20).max(500).optional(),
    area: AreaName.optional(),
    category: PostCategory.optional(),
    /** The photo has a face or number plate: publish without it. */
    removePhoto: z.boolean().optional(),
  }),
  z.object({ action: z.literal('reject'), reason }),
  z.object({ action: z.literal('remove'), reason }),
]);
const officialPost = z.object({
  category: PostCategory,
  area: z.union([AreaName, z.literal('All Noida')]),
  body: z.string().trim().min(20).max(500),
});
const appsQuery = z.object({
  status: z.enum(['under_review', 'approved', 'rejected']).default('under_review'),
});
const decision = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve'), reason: reason.optional() }),
  z.object({ decision: z.literal('reject'), reason }),
]);
const planChange = z.object({
  name: z.string().trim().min(2).max(40).optional(),
  monthlyPriceInr: z.number().int().min(0).max(100_000).nullable().optional(),
  yearlyPriceInr: z.number().int().min(0).max(1_000_000).nullable().optional(),
  monthlyProductId: z.string().trim().max(200).nullable().optional(),
  yearlyProductId: z.string().trim().max(200).nullable().optional(),
  features: z.array(z.string().trim().min(2).max(120)).max(12).optional(),
  evidenceStorageMb: z.number().int().min(100).max(1_000_000).optional(),
  onSale: z.boolean().optional(),
});

const uuid = new ParseUUIDPipe({ exceptionFactory: () => new NotFoundException('Not found') });

/** Admin side of Phase 2. There are no routes for evidence or full-day location. */
@Injectable()
export class AdminPhase2Service {
  constructor(
    private readonly database: DatabaseService,
    private readonly storage: StorageService,
    private readonly messages: OutgoingMessages,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ---- Community moderation -------------------------------------------------------------------

  async posts(status: string, before?: string) {
    let q = this.database.db
      .selectFrom('community_posts')
      .select([
        'id',
        'category',
        'area',
        'body',
        'photo_key',
        'status',
        'reason',
        'flags_count',
        'author_admin_id',
        'created_at',
        'reviewed_at',
      ])
      .where('status', '=', status as 'pending');
    if (before) q = q.where('created_at', '<', new Date(before));
    const rows = await q.orderBy('created_at', 'desc').limit(PAGE).execute();
    const items = await Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        category: r.category,
        area: r.area,
        body: r.body,
        photoUrl: r.photo_key
          ? await this.storage.downloadUrl(r.photo_key, PHOTO_LINK_SECONDS)
          : null,
        status: r.status,
        reason: r.reason,
        flags: r.flags_count,
        official: r.author_admin_id !== null,
        createdAt: r.created_at.toISOString(),
        reviewedAt: r.reviewed_at?.toISOString() ?? null,
      })),
    );
    const pending = await this.database.db
      .selectFrom('community_posts')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow();
    return { items, pendingCount: Number(pending.n), hasMore: rows.length === PAGE };
  }

  async moderate(adminId: string, id: string, input: z.infer<typeof moderate>) {
    const post = await this.database.db
      .selectFrom('community_posts')
      .select(['author_user_id', 'photo_key', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!post) throw new NotFoundException('Post not found');
    if (input.action === 'approve') {
      if (input.removePhoto && post.photo_key)
        await this.storage.delete(post.photo_key).catch(() => undefined);
      await this.database.db
        .updateTable('community_posts')
        .set({
          status: 'published',
          reason: null,
          flags_count: 0,
          reviewed_by: adminId,
          reviewed_at: new Date(),
          ...(input.body && { body: input.body }),
          ...(input.area && { area: input.area }),
          ...(input.category && { category: input.category }),
          ...(input.removePhoto && { photo_key: null }),
        })
        .where('id', '=', id)
        .execute();
      // Flags are reset: the post was looked at again.
      await this.database.db.deleteFrom('community_flags').where('post_id', '=', id).execute();
      if (post.author_user_id && post.status === 'pending') {
        await this.messages.notifyUser(
          post.author_user_id,
          'community_status',
          'Your report is published',
          'Thank you. Others in your area can now see it.',
          { postId: id, status: 'published' },
        );
      }
    } else {
      await this.database.db
        .updateTable('community_posts')
        .set({
          status: input.action === 'reject' ? 'rejected' : 'removed',
          reason: input.reason,
          reviewed_by: adminId,
          reviewed_at: new Date(),
        })
        .where('id', '=', id)
        .execute();
      if (post.author_user_id) {
        await this.messages.notifyUser(
          post.author_user_id,
          'community_status',
          'Your report was not published',
          `Reason: ${input.reason}`,
          { postId: id, status: input.action === 'reject' ? 'rejected' : 'removed' },
        );
      }
    }
    return { ok: true };
  }

  async officialPost(adminId: string, input: z.infer<typeof officialPost>) {
    const id = randomUUID();
    await this.database.db
      .insertInto('community_posts')
      .values({
        id,
        author_admin_id: adminId,
        category: input.category,
        area: input.area,
        body: input.body,
        status: 'published',
        reviewed_by: adminId,
        reviewed_at: new Date(),
      })
      .execute();
    return { id };
  }

  // ---- Rakshak applications -------------------------------------------------------------------

  async applications(status: string) {
    const rows = await this.database.db
      .selectFrom('rakshak_applications as a')
      // "Available now": yes / no and when last seen only. Admins never see a Rakshak's position
      // (live location is shown to admins only during an active SOS).
      .leftJoin('rakshak_presence as p', 'p.user_id', 'a.user_id')
      .select([
        'a.id',
        'a.areas',
        'a.id_type',
        'a.status',
        'a.created_at',
        'a.decided_at',
        'p.updated_at as presence_at',
        sql<boolean>`coalesce(p.online AND p.updated_at > now() - interval '10 minutes', false)`.as(
          'available_now',
        ),
      ])
      .where('a.status', '=', status as 'under_review')
      .orderBy('a.created_at', status === 'under_review' ? 'asc' : 'desc')
      .limit(200)
      .execute();
    return {
      items: rows.map((r) => ({
        id: r.id,
        // Every area (up to 5), shown as one line: "Sector 6, Sector 18".
        area: r.areas.join(', '),
        idType: r.id_type,
        status: r.status,
        createdAt: r.created_at.toISOString(),
        decidedAt: r.decided_at?.toISOString() ?? null,
        availableNow: r.available_now,
        lastAvailableAt: r.presence_at ? new Date(r.presence_at).toISOString() : null,
      })),
    };
  }

  /** Full details and short-lived document links. Every view is written to the audit log. */
  async application(id: string) {
    const r = await this.database.db
      .selectFrom('rakshak_applications as a')
      .leftJoin('users as u', 'u.id', 'a.user_id')
      .select([
        'a.id',
        'a.locked_details',
        'a.areas',
        'a.id_type',
        'a.id_last4',
        'a.documents',
        'a.status',
        'a.reason',
        'a.consent_at',
        'a.created_at',
        'a.decided_at',
        'u.phone',
      ])
      .where('a.id', '=', id)
      .executeTakeFirst();
    if (!r) throw new NotFoundException('Application not found');
    const details = unlockDetails(this.env, r.locked_details);
    const docs = (r.documents ?? {}) as Record<string, string>;
    const links: Record<string, string> = {};
    for (const [name, key] of Object.entries(docs)) {
      links[name] = await this.storage.downloadUrl(key, DOC_LINK_SECONDS);
    }
    return {
      id: r.id,
      ...details,
      // Phone numbers are partly hidden in the admin panel.
      phone: r.phone ? maskPhone(r.phone) : null,
      area: r.areas.join(', '),
      idType: r.id_type,
      idLast4: r.id_last4,
      documents: links,
      status: r.status,
      reason: r.reason,
      consentAt: r.consent_at.toISOString(),
      createdAt: r.created_at.toISOString(),
      decidedAt: r.decided_at?.toISOString() ?? null,
    };
  }

  async decide(adminId: string, id: string, input: z.infer<typeof decision>) {
    const app = await this.database.db
      .selectFrom('rakshak_applications')
      .select(['user_id', 'status'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!app) throw new NotFoundException('Application not found');
    if (app.status !== 'under_review')
      throw new BadRequestException('This application was already decided');
    const approved = input.decision === 'approve';
    await this.database.db
      .updateTable('rakshak_applications')
      .set({
        status: approved ? 'approved' : 'rejected',
        reason: input.reason ?? null,
        reviewed_by: adminId,
        decided_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
    if (app.user_id) {
      await this.messages.notifyUser(
        app.user_id,
        'rakshak_status',
        approved ? 'You are an approved Rakshak' : 'Your Rakshak application was not approved',
        approved
          ? 'Thank you. Rakshak features will come in a later update.'
          : `Reason: ${input.reason}`,
        { applicationId: id, status: approved ? 'approved' : 'rejected' },
      );
    }
    return { ok: true };
  }

  // ---- Plans and subscriptions ----------------------------------------------------------------

  async plans() {
    const rows = await this.database.db
      .selectFrom('plans')
      .selectAll()
      .orderBy('sort_order')
      .execute();
    const counts = await this.database.db
      .selectFrom('subscriptions')
      .select(['plan_id', sql<string>`count(*)`.as('n')])
      .where('status', '=', 'active')
      .groupBy('plan_id')
      .execute();
    return {
      plans: rows.map((r) => ({
        ...toPlan(r),
        activeSubscribers: Number(counts.find((c) => c.plan_id === r.id)?.n ?? 0),
        updatedAt: r.updated_at.toISOString(),
      })),
      everythingFree: !rows.some((r) => r.on_sale),
    };
  }

  async updatePlan(adminId: string, id: string, input: z.infer<typeof planChange>) {
    const plan = await this.database.db
      .selectFrom('plans')
      .selectAll()
      .where('id', '=', id as 'basic')
      .executeTakeFirst();
    if (!plan) throw new NotFoundException('Plan not found');
    const next = {
      monthly: input.monthlyPriceInr === undefined ? plan.monthly_price_inr : input.monthlyPriceInr,
      monthlyId:
        input.monthlyProductId === undefined ? plan.monthly_product_id : input.monthlyProductId,
      onSale: input.onSale ?? plan.on_sale,
    };
    if (next.onSale && id !== 'basic' && (next.monthly === null || !next.monthlyId)) {
      throw new BadRequestException(
        'Set the monthly price and Google Play product id before selling a plan',
      );
    }
    await this.database.db
      .updateTable('plans')
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.monthlyPriceInr !== undefined && { monthly_price_inr: input.monthlyPriceInr }),
        ...(input.yearlyPriceInr !== undefined && { yearly_price_inr: input.yearlyPriceInr }),
        ...(input.monthlyProductId !== undefined && {
          monthly_product_id: input.monthlyProductId || null,
        }),
        ...(input.yearlyProductId !== undefined && {
          yearly_product_id: input.yearlyProductId || null,
        }),
        ...(input.features !== undefined && { features: JSON.stringify(input.features) }),
        ...(input.evidenceStorageMb !== undefined && {
          evidence_storage_mb: input.evidenceStorageMb,
        }),
        ...(input.onSale !== undefined && { on_sale: input.onSale }),
        updated_by: adminId,
      })
      .where('id', '=', id as 'basic')
      .execute();
    return this.plans();
  }

  async subscriptions(status?: string) {
    let q = this.database.db
      .selectFrom('subscriptions as s')
      .leftJoin('users as u', 'u.id', 's.user_id')
      .select([
        's.id',
        's.plan_id',
        's.status',
        's.renews_at',
        's.cancelled_at',
        's.created_at',
        'u.phone',
      ]);
    if (status) q = q.where('s.status', '=', status as 'active');
    const rows = await q.orderBy('s.created_at', 'desc').limit(200).execute();
    return {
      items: rows.map((r) => ({
        id: r.id,
        plan: r.plan_id,
        status: r.status,
        phone: r.phone ? maskPhone(r.phone) : null,
        renewsAt: r.renews_at?.toISOString() ?? null,
        cancelledAt: r.cancelled_at?.toISOString() ?? null,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  // ---- Reports additions (counts only) --------------------------------------------------------

  /**
   * A user's Phase 2 settings and what is in their Mere Saboot, for the user's profile page.
   * Evidence: only that it exists (type, times, size, fingerprint). Never the file, its key, its
   * details or a download link: those are encrypted on the user's phone and only they can open
   * them. Full-day location: on / off only, never the points.
   */
  async userPhase2(userId: string) {
    const db = this.database.db;
    const user = await db
      .selectFrom('users')
      .select('id')
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) throw new NotFoundException('User not found');
    const t = await db
      .selectFrom('sos_trigger_settings')
      .select(['shake_mode', 'voice_on', 'drive_mode', 'fall_on', 'quiet_countdown'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    const daily = await db
      .selectFrom('daily_tracking_settings')
      .select(['enabled', 'paused_until', 'retention_days'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    const vault = await db
      .selectFrom('vault_keys')
      .select('created_at')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    const items = await db
      .selectFrom('evidence_items')
      .select([
        'id',
        'kind',
        'size_bytes',
        'sha256',
        'captured_at',
        'received_at',
        'incident_id',
        'uploaded',
      ])
      .where('user_id', '=', userId)
      .orderBy('received_at', 'desc')
      .execute();
    const incidents = await db
      .selectFrom('evidence_incidents')
      .select(['kind', sql<string>`count(*)`.as('n')])
      .where('user_id', '=', userId)
      .where('deleted_at', 'is', null)
      .groupBy('kind')
      .execute();
    const rakshak = await db
      .selectFrom('rakshak_applications')
      .select(['status', 'areas', 'created_at'])
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();
    const reports = await db
      .selectFrom('community_posts')
      .select(['status', sql<string>`count(*)`.as('n')])
      .where('author_user_id', '=', userId)
      .groupBy('status')
      .execute();
    const byKind: Record<string, number> = {};
    for (const i of items) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
    const pausedUntil = daily?.paused_until ? new Date(daily.paused_until) : null;
    return {
      sosTriggers: {
        shakeMode: t?.shake_mode ?? 'off',
        voiceOn: t?.voice_on ?? false,
        driveMode: t?.drive_mode ?? false,
        fallOn: t?.fall_on ?? false,
        quietCountdown: t?.quiet_countdown ?? false,
      },
      fullDayLocation: {
        enabled: daily?.enabled ?? false,
        paused: pausedUntil !== null && pausedUntil > new Date(),
        retentionDays: daily?.retention_days ?? 30,
      },
      evidence: {
        vaultSetUpAt: vault ? new Date(vault.created_at).toISOString() : null,
        items: items.length,
        sizeBytes: items.reduce((s, i) => s + Number(i.size_bytes), 0),
        byKind,
        incidents: Object.fromEntries(incidents.map((r) => [r.kind, Number(r.n)])),
        latest: items.slice(0, 50).map((i) => ({
          id: i.id,
          kind: i.kind,
          sizeBytes: Number(i.size_bytes),
          sha256: i.sha256,
          capturedAt: new Date(i.captured_at).toISOString(),
          receivedAt: new Date(i.received_at).toISOString(),
          inIncident: i.incident_id !== null,
          uploaded: i.uploaded,
        })),
      },
      rakshak: rakshak
        ? {
            status: rakshak.status,
            area: rakshak.areas.join(', '),
            appliedAt: new Date(rakshak.created_at).toISOString(),
          }
        : null,
      communityReports: Object.fromEntries(reports.map((r) => [r.status, Number(r.n)])),
    };
  }

  async stats(days: number) {
    const db = this.database.db;
    const since = sql<Date>`now() - make_interval(days => ${days})`;
    const triggers = await db
      .selectFrom('sos_events')
      .select(['trigger', sql<string>`count(*)`.as('n')])
      .where('started_at', '>', since)
      .where('is_test', '=', false)
      .groupBy('trigger')
      .execute();
    const cancelled = await db
      .selectFrom('sos_false_alarms')
      .select(['trigger', sql<string>`count(*)`.as('n')])
      .where('created_at', '>', since)
      .groupBy('trigger')
      .execute();
    const one = async (q: Promise<{ n: string } | undefined>) => Number((await q)?.n ?? 0);
    const users = await one(
      db
        .selectFrom('users')
        .select(sql<string>`count(*)`.as('n'))
        .where('consent_at', 'is not', null)
        .executeTakeFirst(),
    );
    const fullDay = await one(
      db
        .selectFrom('daily_tracking_settings')
        .select(sql<string>`count(*)`.as('n'))
        .where('enabled', '=', true)
        .executeTakeFirst(),
    );
    const vaultUsers = await one(
      db
        .selectFrom('vault_keys')
        .select(sql<string>`count(*)`.as('n'))
        .executeTakeFirst(),
    );
    const triggerUsers = await db
      .selectFrom('sos_trigger_settings')
      .select([
        sql<string>`count(*) FILTER (WHERE shake_mode <> 'off')`.as('shake'),
        sql<string>`count(*) FILTER (WHERE voice_on)`.as('voice'),
        sql<string>`count(*) FILTER (WHERE drive_mode)`.as('drive'),
        sql<string>`count(*) FILTER (WHERE fall_on)`.as('fall'),
        sql<string>`count(*) FILTER (WHERE quiet_countdown)`.as('quiet'),
      ])
      .executeTakeFirstOrThrow();
    const toMap = (rows: { trigger: string; n: string }[]) =>
      Object.fromEntries(rows.map((r) => [r.trigger, Number(r.n)]));
    return {
      days,
      sosByTrigger: toMap(triggers),
      falseAlarmsByTrigger: toMap(cancelled),
      users,
      fullDayLocationUsers: fullDay,
      fullDayLocationRate: users ? Math.round((fullDay / users) * 1000) / 10 : 0,
      vaultUsers,
      turnedOn: {
        shake: Number(triggerUsers.shake),
        voice: Number(triggerUsers.voice),
        driveMode: Number(triggerUsers.drive),
        fall: Number(triggerUsers.fall),
        quietCountdown: Number(triggerUsers.quiet),
      },
    };
  }
}

/** "+91 98•• ••4521" (CLAUDE.md rule 7). */
export function maskPhone(phone: string): string {
  const d = phone.replace(/^\+91/, '');
  return `+91 ${d.slice(0, 2)}•• ••${d.slice(-4)}`;
}

@Controller('admin')
export class AdminPhase2Controller {
  constructor(private readonly service: AdminPhase2Service) {}

  @Get('community/posts')
  posts(@Query() query: unknown) {
    const q = parseBody(postsQuery, query);
    return this.service.posts(q.status, q.before);
  }

  @Patch('community/posts/:id')
  moderate(@Req() req: HttpRequest, @Param('id', uuid) id: string, @Body() body: unknown) {
    return this.service.moderate(req.admin!.id, id, parseBody(moderate, body));
  }

  @Post('community/posts')
  @HttpCode(200)
  official(@Req() req: HttpRequest, @Body() body: unknown) {
    return this.service.officialPost(req.admin!.id, parseBody(officialPost, body));
  }

  @Roles('super_admin')
  @Get('rakshak/applications')
  applications(@Query() query: unknown) {
    return this.service.applications(parseBody(appsQuery, query).status);
  }

  @Roles('super_admin')
  @Get('rakshak/applications/:id')
  application(@Param('id', uuid) id: string) {
    return this.service.application(id);
  }

  @Roles('super_admin')
  @Post('rakshak/applications/:id/decision')
  @HttpCode(200)
  decide(@Req() req: HttpRequest, @Param('id', uuid) id: string, @Body() body: unknown) {
    return this.service.decide(req.admin!.id, id, parseBody(decision, body));
  }

  @Roles('super_admin')
  @Get('plans')
  plans() {
    return this.service.plans();
  }

  @Roles('super_admin')
  @Put('plans/:id')
  updatePlan(@Req() req: HttpRequest, @Param('id') id: string, @Body() body: unknown) {
    if (!['basic', 'silver', 'gold'].includes(id)) throw new NotFoundException('Plan not found');
    return this.service.updatePlan(req.admin!.id, id, parseBody(planChange, body));
  }

  @Roles('super_admin')
  @Get('subscriptions')
  subscriptions(@Query('status') status?: string) {
    const s =
      status && ['active', 'pending', 'cancelled', 'expired', 'refunded'].includes(status)
        ? status
        : undefined;
    return this.service.subscriptions(s);
  }

  /** Both roles. Written to the audit log (a view of this user). No evidence content, ever. */
  @Get('users/:id/phase2')
  userPhase2(@Param('id', uuid) id: string) {
    return this.service.userPhase2(id);
  }

  @Get('phase2/stats')
  stats(@Query('days') days?: string) {
    const d = Number(days);
    return this.service.stats([7, 30, 90].includes(d) ? d : 30);
  }
}
