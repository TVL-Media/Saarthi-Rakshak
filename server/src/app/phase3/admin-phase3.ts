import {
  Body,
  ConflictException,
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
import { z } from 'zod';
import { Roles } from '../../auth/auth.decorators';
import { parseBody, type HttpRequest } from '../../common/http';
import { DatabaseService } from '../../database/database.module';
import type { BookingStatus } from '../../database/types';
import { OutgoingMessages } from '../messages/outgoing-messages';
import { maskPhone } from '../phase2/admin-phase2';
import { firstName, loadBooking } from './bookings';

const PAGE = 50;
const STATUSES = [
  'requested',
  'quoted',
  'confirmed',
  'assigned',
  'in_progress',
  'completed',
  'cancelled',
] as const;

const listQuery = z.object({
  status: z.enum(STATUSES).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
});
const reason = z
  .string()
  .trim()
  .min(5, { error: 'Write a reason (at least 5 characters)' })
  .max(500);
const quoteBody = z.object({
  amountPaise: z.number().int().min(0).max(100_000_00),
  note: z.string().trim().max(200).optional(),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});
const assignBody = z.object({ rakshakUserId: z.uuid() });
const advanceBody = z.object({ status: z.enum(['in_progress', 'completed']) });
const cancelBody = z.object({ reason });

const uuid = new ParseUUIDPipe({ exceptionFactory: () => new NotFoundException('Not found') });

/** Admin side of Phase 3 bookings. No coordinates are returned: admins see the place label only. */
@Injectable()
export class AdminPhase3Service {
  constructor(
    private readonly database: DatabaseService,
    private readonly messages: OutgoingMessages,
  ) {}

  async list(status?: string, before?: string) {
    let q = this.database.db
      .selectFrom('bookings as b')
      .innerJoin('booking_services as s', 's.id', 'b.service_type')
      .innerJoin('users as u', 'u.id', 'b.user_id')
      .leftJoin('users as r', 'r.id', 'b.rakshak_user_id')
      .select([
        'b.id',
        's.name as service_name',
        'b.status',
        'b.window_start',
        'b.window_end',
        'b.place_label',
        'b.quote_amount_paise',
        'b.created_at',
        'u.id as user_id',
        'u.name as user_name',
        'u.phone as user_phone',
        'r.name as rakshak_name',
        'b.rakshak_user_id',
      ]);
    if (status) q = q.where('b.status', '=', status as BookingStatus);
    if (before) q = q.where('b.created_at', '<', new Date(before));
    const rows = await q
      .orderBy('b.created_at', 'desc')
      .limit(PAGE + 1)
      .execute();
    const counts = await this.database.db
      .selectFrom('bookings')
      .select(['status'])
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .groupBy('status')
      .execute();
    return {
      items: rows.slice(0, PAGE).map((r) => ({
        id: r.id,
        serviceName: r.service_name,
        status: r.status,
        windowStart: new Date(r.window_start).toISOString(),
        windowEnd: new Date(r.window_end).toISOString(),
        placeLabel: r.place_label,
        quoteAmountPaise: r.quote_amount_paise,
        userId: r.user_id,
        userName: r.user_name,
        userPhone: maskPhone(r.user_phone),
        rakshakName: r.rakshak_user_id ? firstName(r.rakshak_name) : null,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      more: rows.length > PAGE,
      counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
    };
  }

  async detail(id: string) {
    const booking = await loadBooking(this.database, id);
    if (!booking) throw new NotFoundException('Not found');
    const row = await this.database.db
      .selectFrom('bookings as b')
      .innerJoin('users as u', 'u.id', 'b.user_id')
      .select(['u.id as user_id', 'u.name', 'u.phone', 'b.cancel_reason', 'b.rakshak_user_id'])
      .where('b.id', '=', id)
      .executeTakeFirstOrThrow();
    // Never the exact position: the place label and the booking details are enough to work with.
    const { place, ...rest } = booking;
    return {
      ...rest,
      placeLabel: place.label,
      cancelReason: row.cancel_reason,
      rakshakUserId: row.rakshak_user_id,
      user: { id: row.user_id, name: row.name, phone: maskPhone(row.phone) },
    };
  }

  /** Approved Rakshaks, for the "assign" choice. */
  async rakshaks() {
    const rows = await this.database.db
      .selectFrom('rakshak_applications as a')
      .innerJoin('users as u', 'u.id', 'a.user_id')
      .leftJoin('rakshak_presence as p', 'p.user_id', 'a.user_id')
      .select(['u.id', 'u.name', 'a.areas', 'p.online'])
      .where('a.status', '=', 'approved')
      .where('u.status', '=', 'active')
      .orderBy('u.name')
      .execute();
    return {
      items: rows.map((r) => ({
        userId: r.id,
        firstName: firstName(r.name),
        area: r.areas.join(', '),
        online: r.online === true,
      })),
    };
  }

  async quote(adminId: string, id: string, input: z.infer<typeof quoteBody>) {
    await this.move(adminId, id, ['requested', 'quoted'], 'quoted', {
      note: input.note ?? null,
      set: {
        quote_amount_paise: input.amountPaise,
        quote_note: input.note ?? null,
        quote_expires_at: input.expiresAt ? new Date(input.expiresAt) : null,
      },
      push: ['Your booking has a quote', 'Open My Bookings to accept or decline it.'],
    });
    return this.detail(id);
  }

  async assign(adminId: string, id: string, rakshakUserId: string) {
    const ok = await this.database.db
      .selectFrom('rakshak_applications as a')
      .innerJoin('users as u', 'u.id', 'a.user_id')
      .select('a.user_id')
      .where('a.user_id', '=', rakshakUserId)
      .where('a.status', '=', 'approved')
      .where('u.status', '=', 'active')
      .executeTakeFirst();
    if (!ok) throw new ConflictException('Choose an approved Rakshak');
    await this.move(adminId, id, ['requested', 'confirmed', 'assigned'], 'assigned', {
      note: 'Rakshak assigned',
      set: { rakshak_user_id: rakshakUserId },
      push: ['A Rakshak is assigned to your booking', 'Open My Bookings to see the details.'],
    });
    return this.detail(id);
  }

  async advance(adminId: string, id: string, status: 'in_progress' | 'completed') {
    await this.move(
      adminId,
      id,
      status === 'in_progress' ? ['assigned'] : ['assigned', 'in_progress'],
      status,
      {
        note: null,
        set: {},
        push: [
          status === 'in_progress' ? 'Your booking has started' : 'Your booking is complete',
          'Open My Bookings to see the details.',
        ],
      },
    );
    return this.detail(id);
  }

  async cancel(adminId: string, id: string, why: string) {
    await this.move(
      adminId,
      id,
      ['requested', 'quoted', 'confirmed', 'assigned', 'in_progress'],
      'cancelled',
      {
        note: why,
        set: { cancel_reason: why },
        push: ['Your booking was cancelled', `Reason: ${why}`],
      },
    );
    return this.detail(id);
  }

  /** One status change, only if the booking is in an allowed state; recorded with the admin's id. */
  private async move(
    adminId: string,
    id: string,
    from: BookingStatus[],
    to: BookingStatus,
    o: {
      note: string | null;
      set: Record<string, string | number | Date | null>;
      push: [string, string];
    },
  ): Promise<void> {
    const userId = await this.database.db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable('bookings')
        .set({ status: to, ...o.set })
        .where('id', '=', id)
        .where('status', 'in', from)
        .returning('user_id')
        .executeTakeFirst();
      if (!row) {
        const exists = await trx
          .selectFrom('bookings')
          .select('id')
          .where('id', '=', id)
          .executeTakeFirst();
        if (!exists) throw new NotFoundException('Not found');
        throw new ConflictException('This booking is not in a state where that can be done');
      }
      await trx
        .insertInto('booking_events')
        .values({ booking_id: id, status: to, actor: 'admin', admin_id: adminId, note: o.note })
        .execute();
      return row.user_id;
    });
    await this.messages.notifyUser(userId, 'booking_status', o.push[0], o.push[1], {
      bookingId: id,
      status: to,
    });
  }
}

@Controller('admin/bookings')
export class AdminPhase3Controller {
  constructor(private readonly service: AdminPhase3Service) {}

  @Get()
  list(@Query() query: unknown) {
    const q = parseBody(listQuery, query);
    return this.service.list(q.status, q.before);
  }

  @Get('rakshaks')
  rakshaks() {
    return this.service.rakshaks();
  }

  @Get(':id')
  detail(@Param('id', uuid) id: string) {
    return this.service.detail(id);
  }

  @Roles('super_admin')
  @Post(':id/quote')
  @HttpCode(200)
  quote(@Req() req: HttpRequest, @Param('id', uuid) id: string, @Body() body: unknown) {
    return this.service.quote(req.admin!.id, id, parseBody(quoteBody, body));
  }

  @Post(':id/assign')
  @HttpCode(200)
  assign(@Req() req: HttpRequest, @Param('id', uuid) id: string, @Body() body: unknown) {
    return this.service.assign(req.admin!.id, id, parseBody(assignBody, body).rakshakUserId);
  }

  @Post(':id/status')
  @HttpCode(200)
  status(@Req() req: HttpRequest, @Param('id', uuid) id: string, @Body() body: unknown) {
    return this.service.advance(req.admin!.id, id, parseBody(advanceBody, body).status);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Req() req: HttpRequest, @Param('id', uuid) id: string, @Body() body: unknown) {
    return this.service.cancel(req.admin!.id, id, parseBody(cancelBody, body).reason);
  }
}
