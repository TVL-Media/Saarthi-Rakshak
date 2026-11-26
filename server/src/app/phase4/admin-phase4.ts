import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { Roles } from '../../auth/auth.decorators';
import { parseBody, type HttpRequest } from '../../common/http';
import { DatabaseService } from '../../database/database.module';
import type { PartnerKind, PartnerRequestStatus, PartnerStatus } from '../../database/types';
import { OutgoingMessages } from '../messages/outgoing-messages';
import { maskPhone } from '../phase2/admin-phase2';

const uuid = new ParseUUIDPipe({ exceptionFactory: () => new NotFoundException('Not found') });
const PAGE = 100;

const reason = z
  .string()
  .trim()
  .min(5, { error: 'Write a reason (at least 5 characters)' })
  .max(500);

const partnerListQuery = z.object({
  kind: z.enum(['safe_point', 'women_support', 'lawyer']).optional(),
  status: z.enum(['submitted', 'verified', 'approved', 'rejected', 'expired']).optional(),
});

const partnerBody = z.object({
  kind: z.enum(['safe_point', 'women_support', 'lawyer']),
  name: z.string().trim().min(2).max(120),
  category: z.string().trim().min(2).max(40),
  address: z.string().trim().max(240).nullish(),
  city: z.string().trim().max(80).nullish(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{5,20}$/, { error: 'Enter a phone number' })
    .nullish(),
  hours: z.string().trim().max(160).nullish(),
  languages: z.array(z.string().trim().min(2).max(20)).max(10).default([]),
  services: z.string().trim().max(400).nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
});

const partnerAction = z.object({
  action: z.enum(['verify', 'approve', 'reject', 'expire']),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  reason: reason.optional(),
});

const requestListQuery = z.object({
  status: z
    .enum(['requested', 'accepted', 'declined', 'contacted', 'in_progress', 'closed'])
    .optional(),
  kind: z.enum(['women_support', 'legal']).optional(),
});

const requestStatusBody = z.object({
  status: z.enum(['accepted', 'declined', 'contacted', 'in_progress', 'closed']),
  // Shown to the user in their timeline. Internal notes are separate and never reach the user.
  message: z.string().trim().max(300).optional(),
  internalNote: z.string().trim().max(1000).optional(),
  partnerId: z.uuid().nullish(),
});

const guidanceBody = z.object({
  situation: z.enum(['threat', 'harassment', 'stalking', 'medical', 'travel', 'child', 'senior']),
  title: z.string().trim().min(3).max(120),
  steps: z.array(z.string().trim().min(3).max(300)).min(1).max(12),
  language: z.string().trim().min(2).max(8).default('en'),
});

const guidanceApprove = z.object({
  reviewedOn: z.iso.date(),
  reviewDue: z.iso.date(),
});

const PUSH_TEXT: Record<string, string> = {
  accepted: 'A partner accepted your request.',
  declined: 'Your request could not be taken up. You can choose another partner.',
  contacted: 'A partner has contacted you.',
  in_progress: 'Your request is in progress.',
  closed: 'Your request was closed.',
};

/** Admin side of Phase 4: the partner lifecycle, support and legal requests, reviewed guidance. */
@Injectable()
export class AdminPhase4Service {
  constructor(
    private readonly database: DatabaseService,
    private readonly messages: OutgoingMessages,
  ) {}

  // -- Partners ------------------------------------------------------------------------------

  /** Listings past their expiry lose the badge at once (the app checks the date); this keeps the label true too. */
  private async expireOld(): Promise<void> {
    await this.database.db
      .updateTable('partners')
      .set({ status: 'expired' })
      .where('status', '=', 'approved')
      .where('expires_at', '<=', new Date())
      .execute();
  }

  async partners(kind?: PartnerKind, status?: PartnerStatus) {
    await this.expireOld();
    let q = this.database.db
      .selectFrom('partners')
      .select([
        'id',
        'kind',
        'name',
        'category',
        'city',
        'phone',
        'status',
        'expires_at',
        'verified_at',
        'created_at',
        sql<number | null>`ST_Y(location::geometry)`.as('lat'),
        sql<number | null>`ST_X(location::geometry)`.as('lng'),
      ]);
    if (kind) q = q.where('kind', '=', kind);
    if (status) q = q.where('status', '=', status);
    const rows = await q.orderBy('created_at', 'desc').limit(PAGE).execute();
    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        name: r.name,
        category: r.category,
        city: r.city,
        phone: r.phone,
        status: r.status,
        hasLocation: r.lat !== null,
        expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
        verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : null,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    };
  }

  async partner(id: string) {
    const r = await this.database.db
      .selectFrom('partners')
      .select([
        'id',
        'kind',
        'name',
        'category',
        'address',
        'city',
        'phone',
        'hours',
        'languages',
        'services',
        'status',
        'expires_at',
        sql<number | null>`ST_Y(location::geometry)`.as('lat'),
        sql<number | null>`ST_X(location::geometry)`.as('lng'),
      ])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) throw new NotFoundException('Not found');
    return { ...r, expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null };
  }

  async createPartner(adminId: string, b: z.infer<typeof partnerBody>) {
    const hasPoint = b.lat != null && b.lng != null;
    if (b.kind === 'safe_point' && !hasPoint) {
      throw new NotFoundException('A safe point needs a map location (latitude and longitude).');
    }
    const row = await this.database.db
      .insertInto('partners')
      .values({
        kind: b.kind,
        name: b.name,
        category: b.category,
        address: b.address ?? null,
        city: b.city ?? null,
        phone: b.phone ?? null,
        hours: b.hours ?? null,
        languages: b.languages,
        services: b.services ?? null,
        location: hasPoint
          ? sql<string>`ST_SetSRID(ST_MakePoint(${b.lng}, ${b.lat}), 4326)::geography`
          : null,
        created_by: adminId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return this.partner(row.id);
  }

  async updatePartner(id: string, b: z.infer<typeof partnerBody>) {
    const hasPoint = b.lat != null && b.lng != null;
    const res = await this.database.db
      .updateTable('partners')
      .set({
        name: b.name,
        category: b.category,
        address: b.address ?? null,
        city: b.city ?? null,
        phone: b.phone ?? null,
        hours: b.hours ?? null,
        languages: b.languages,
        services: b.services ?? null,
        location: hasPoint
          ? sql<string>`ST_SetSRID(ST_MakePoint(${b.lng}, ${b.lat}), 4326)::geography`
          : null,
        // Changed details must be checked again: the badge comes off until it is re-verified.
        status: 'submitted',
        verified_at: null,
        verified_by: null,
        expires_at: null,
      })
      .where('id', '=', id)
      .executeTakeFirst();
    if (res.numUpdatedRows === 0n) throw new NotFoundException('Not found');
    return this.partner(id);
  }

  async partnerAction(adminId: string, role: string, id: string, b: z.infer<typeof partnerAction>) {
    const current = await this.database.db
      .selectFrom('partners')
      .select(['status', 'kind'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!current) throw new NotFoundException('Not found');
    const needsSuper = b.action === 'approve' || b.action === 'reject' || b.action === 'expire';
    if (needsSuper && role !== 'super_admin')
      throw new NotFoundException('Only a Super Admin can do this.');
    if ((b.action === 'reject' || b.action === 'expire') && !b.reason) {
      throw new NotFoundException('Write a reason (at least 5 characters).');
    }
    if (b.action === 'verify') {
      if (current.status !== 'submitted')
        throw new NotFoundException('Only a submitted listing can be verified.');
      await this.database.db
        .updateTable('partners')
        .set({ status: 'verified', verified_at: new Date(), verified_by: adminId })
        .where('id', '=', id)
        .execute();
    } else if (b.action === 'approve') {
      if (current.status !== 'verified')
        throw new NotFoundException('Verify the listing before approving it.');
      const expires = b.expiresAt ? new Date(b.expiresAt) : new Date(Date.now() + 365 * 86_400_000);
      if (expires <= new Date())
        throw new NotFoundException('The expiry date must be in the future.');
      await this.database.db
        .updateTable('partners')
        .set({ status: 'approved', expires_at: expires })
        .where('id', '=', id)
        .execute();
    } else if (b.action === 'reject') {
      await this.database.db
        .updateTable('partners')
        .set({ status: 'rejected', expires_at: null })
        .where('id', '=', id)
        .execute();
    } else {
      await this.database.db
        .updateTable('partners')
        .set({ status: 'expired', expires_at: new Date() })
        .where('id', '=', id)
        .execute();
    }
    return this.partner(id);
  }

  // -- Requests ------------------------------------------------------------------------------

  async requests(status?: PartnerRequestStatus, kind?: 'women_support' | 'legal') {
    let q = this.database.db
      .selectFrom('partner_requests as r')
      .innerJoin('users as u', 'u.id', 'r.user_id')
      .leftJoin('partners as p', 'p.id', 'r.partner_id')
      .select([
        'r.id',
        'r.kind',
        'r.category',
        'r.urgency',
        'r.status',
        'r.reference',
        'r.created_at',
        'u.phone as user_phone',
        'p.name as partner_name',
      ]);
    if (status) q = q.where('r.status', '=', status);
    if (kind) q = q.where('r.kind', '=', kind);
    const rows = await q.orderBy('r.created_at', 'desc').limit(PAGE).execute();
    return {
      items: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        category: r.category,
        urgency: r.urgency,
        status: r.status,
        reference: r.reference,
        userPhone: maskPhone(r.user_phone),
        partnerName: r.partner_name,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    };
  }

  async request(id: string) {
    const r = await this.database.db
      .selectFrom('partner_requests as r')
      .innerJoin('users as u', 'u.id', 'r.user_id')
      .leftJoin('partners as p', 'p.id', 'r.partner_id')
      .select([
        'r.id',
        'r.kind',
        'r.category',
        'r.urgency',
        'r.preferred_contact',
        'r.summary',
        'r.status',
        'r.reference',
        'r.internal_note',
        'r.shared_item_ids',
        'r.shared_until',
        'r.partner_id',
        'r.created_at',
        'u.phone as user_phone',
        'p.name as partner_name',
      ])
      .where('r.id', '=', id)
      .executeTakeFirst();
    if (!r) throw new NotFoundException('Not found');
    const events = await this.database.db
      .selectFrom('partner_request_events')
      .select(['status', 'actor', 'note', 'created_at'])
      .where('request_id', '=', id)
      .orderBy('id')
      .execute();
    return {
      id: r.id,
      kind: r.kind,
      category: r.category,
      urgency: r.urgency,
      preferredContact: r.preferred_contact,
      summary: r.summary,
      status: r.status,
      reference: r.reference,
      internalNote: r.internal_note,
      // Only the number of items is shown. Vault content is never reachable from the admin panel.
      sharedItemCount: r.shared_item_ids.length,
      sharedUntil: r.shared_until ? new Date(r.shared_until).toISOString() : null,
      partnerId: r.partner_id,
      partnerName: r.partner_name,
      userPhone: maskPhone(r.user_phone),
      timeline: events.map((e) => ({
        status: e.status,
        by: e.actor,
        note: e.note,
        at: new Date(e.created_at).toISOString(),
      })),
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  async setRequestStatus(adminId: string, id: string, b: z.infer<typeof requestStatusBody>) {
    const current = await this.database.db
      .selectFrom('partner_requests')
      .select(['user_id', 'status', 'kind'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!current) throw new NotFoundException('Not found');
    if (current.status === 'closed') throw new NotFoundException('This request is closed.');
    if (b.partnerId) {
      const ok = await this.database.db
        .selectFrom('partners')
        .select('id')
        .where('id', '=', b.partnerId)
        .where('kind', '=', current.kind === 'legal' ? 'lawyer' : 'women_support')
        .where('status', '=', 'approved')
        .executeTakeFirst();
      if (!ok) throw new NotFoundException('Choose an approved partner of the right kind.');
    }
    await this.database.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('partner_requests')
        .set({
          status: b.status,
          ...(b.partnerId && { partner_id: b.partnerId }),
          ...(b.internalNote !== undefined && { internal_note: b.internalNote }),
        })
        .where('id', '=', id)
        .execute();
      await trx
        .insertInto('partner_request_events')
        .values({
          request_id: id,
          status: b.status,
          actor: 'admin',
          admin_id: adminId,
          note: b.message ?? null,
        })
        .execute();
    });
    await this.messages.notifyUser(
      current.user_id,
      'partner_request_status',
      'Your request was updated',
      PUSH_TEXT[b.status],
      {
        requestId: id,
        status: b.status,
      },
    );
    return this.request(id);
  }

  // -- Guidance ------------------------------------------------------------------------------

  async guidance() {
    const rows = await this.database.db
      .selectFrom('guidance_articles')
      .select([
        'id',
        'situation',
        'title',
        'steps',
        'language',
        'status',
        'reviewed_on',
        'review_due',
        'updated_at',
      ])
      .orderBy('updated_at', 'desc')
      .limit(PAGE)
      .execute();
    const today = new Date().toISOString().slice(0, 10);
    return {
      items: rows.map((r) => {
        const due = r.review_due ? String(r.review_due).slice(0, 10) : null;
        return {
          id: r.id,
          situation: r.situation,
          title: r.title,
          steps: r.steps,
          language: r.language,
          status: r.status,
          reviewedOn: r.reviewed_on ? String(r.reviewed_on).slice(0, 10) : null,
          reviewDue: due,
          // Past its review date the app stops showing it as current.
          reviewExpired: r.status === 'approved' && (due === null || due < today),
        };
      }),
    };
  }

  async createGuidance(adminId: string, b: z.infer<typeof guidanceBody>) {
    await this.database.db
      .insertInto('guidance_articles')
      .values({ ...b, steps: JSON.stringify(b.steps), created_by: adminId })
      .execute();
    return this.guidance();
  }

  async updateGuidance(id: string, b: z.infer<typeof guidanceBody>) {
    const res = await this.database.db
      .updateTable('guidance_articles')
      // An edited article must be reviewed and approved again.
      .set({
        ...b,
        steps: JSON.stringify(b.steps),
        status: 'draft',
        reviewed_on: null,
        review_due: null,
        approved_by: null,
      })
      .where('id', '=', id)
      .executeTakeFirst();
    if (res.numUpdatedRows === 0n) throw new NotFoundException('Not found');
    return this.guidance();
  }

  async approveGuidance(adminId: string, id: string, b: z.infer<typeof guidanceApprove>) {
    if (b.reviewDue <= b.reviewedOn)
      throw new NotFoundException('The next review date must be after the review date.');
    const res = await this.database.db
      .updateTable('guidance_articles')
      .set({
        status: 'approved',
        reviewed_on: b.reviewedOn,
        review_due: b.reviewDue,
        approved_by: adminId,
      })
      .where('id', '=', id)
      .executeTakeFirst();
    if (res.numUpdatedRows === 0n) throw new NotFoundException('Not found');
    return this.guidance();
  }

  async retireGuidance(id: string) {
    await this.database.db
      .updateTable('guidance_articles')
      .set({ status: 'retired' })
      .where('id', '=', id)
      .execute();
    return this.guidance();
  }

  // -- Overview (counts only: reports and child data are private) ------------------------------

  async overview() {
    const db = this.database.db;
    const [reports, requests, links, partners] = await Promise.all([
      db
        .selectFrom('incident_reports')
        .select(['kind', 'status'])
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .groupBy(['kind', 'status'])
        .execute(),
      db
        .selectFrom('partner_requests')
        .select(['status'])
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .groupBy('status')
        .execute(),
      db
        .selectFrom('child_links')
        .select(['status'])
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .groupBy('status')
        .execute(),
      db
        .selectFrom('partners')
        .select(['kind', 'status'])
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .groupBy(['kind', 'status'])
        .execute(),
    ]);
    return {
      reports: reports.map((r) => ({ kind: r.kind, status: r.status, count: Number(r.n) })),
      requests: requests.map((r) => ({ status: r.status, count: Number(r.n) })),
      childLinks: links.map((r) => ({ status: r.status, count: Number(r.n) })),
      partners: partners.map((r) => ({ kind: r.kind, status: r.status, count: Number(r.n) })),
    };
  }
}

@Controller('admin/phase4')
export class AdminPhase4Controller {
  constructor(private readonly service: AdminPhase4Service) {}

  @Get('overview')
  overview() {
    return this.service.overview();
  }

  @Get('partners')
  partners(@Query() query: unknown) {
    const q = parseBody(partnerListQuery, query);
    return this.service.partners(q.kind, q.status);
  }

  @Post('partners')
  @HttpCode(200)
  createPartner(@Req() req: HttpRequest, @Body() body: unknown) {
    return this.service.createPartner(req.admin!.id, parseBody(partnerBody, body));
  }

  @Get('partners/:id')
  partner(@Param('id', uuid) id: string) {
    return this.service.partner(id);
  }

  @Post('partners/:id')
  @HttpCode(200)
  updatePartner(@Param('id', uuid) id: string, @Body() body: unknown) {
    return this.service.updatePartner(id, parseBody(partnerBody, body));
  }

  @Post('partners/:id/action')
  @HttpCode(200)
  partnerAction(@Req() req: HttpRequest, @Param('id', uuid) id: string, @Body() body: unknown) {
    return this.service.partnerAction(
      req.admin!.id,
      req.admin!.role,
      id,
      parseBody(partnerAction, body),
    );
  }

  @Get('requests')
  requests(@Query() query: unknown) {
    const q = parseBody(requestListQuery, query);
    return this.service.requests(q.status, q.kind);
  }

  @Get('requests/:id')
  request(@Param('id', uuid) id: string) {
    return this.service.request(id);
  }

  @Post('requests/:id/status')
  @HttpCode(200)
  requestStatus(@Req() req: HttpRequest, @Param('id', uuid) id: string, @Body() body: unknown) {
    return this.service.setRequestStatus(req.admin!.id, id, parseBody(requestStatusBody, body));
  }

  @Get('guidance')
  guidance() {
    return this.service.guidance();
  }

  @Post('guidance')
  @HttpCode(200)
  createGuidance(@Req() req: HttpRequest, @Body() body: unknown) {
    return this.service.createGuidance(req.admin!.id, parseBody(guidanceBody, body));
  }

  @Post('guidance/:id')
  @HttpCode(200)
  updateGuidance(@Param('id', uuid) id: string, @Body() body: unknown) {
    return this.service.updateGuidance(id, parseBody(guidanceBody, body));
  }

  @Roles('super_admin')
  @Post('guidance/:id/approve')
  @HttpCode(200)
  approveGuidance(@Req() req: HttpRequest, @Param('id', uuid) id: string, @Body() body: unknown) {
    return this.service.approveGuidance(req.admin!.id, id, parseBody(guidanceApprove, body));
  }

  @Roles('super_admin')
  @Post('guidance/:id/retire')
  @HttpCode(200)
  retireGuidance(@Param('id', uuid) id: string) {
    return this.service.retireGuidance(id);
  }
}
