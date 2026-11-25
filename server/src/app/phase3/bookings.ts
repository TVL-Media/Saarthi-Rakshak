import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { sql } from 'kysely';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.module';
import type { BookingStatus } from '../../database/types';
import { appError, parseAppBody, type AppRequest } from '../common/app-http';
import { AppSettings } from '../common/app-settings';
import { AppRateLimiter } from '../common/rate-limit';

/** How far the app may ask for, how often the open screen refreshes, how fresh a position must be. */
export const NEARBY_MAX_RADIUS_M = 5000;
export const NEARBY_REFRESH_SECONDS = 30;
const PRESENCE_FRESH_MINUTES = 10;
const MAX_OPEN_BOOKINGS = 5;
const OPEN: BookingStatus[] = ['requested', 'quoted', 'confirmed', 'assigned', 'in_progress'];

const nearbyQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radiusM: z.coerce.number().int().min(100).max(NEARBY_MAX_RADIUS_M).default(2000),
});

const createBody = z
  .object({
    id: z.uuid(),
    serviceType: z.string().min(1).max(40),
    windowStart: z.iso.datetime({ offset: true }),
    windowEnd: z.iso.datetime({ offset: true }),
    place: z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      label: z.string().trim().max(120).nullish(),
    }),
    notes: z.string().trim().max(300).nullish(),
  })
  .refine((b) => new Date(b.windowEnd) > new Date(b.windowStart), {
    path: ['windowEnd'],
    error: 'Must be after the start',
  });

const cancelBody = z.object({ reason: z.string().trim().max(300).nullish() });

const uuid = new ParseUUIDPipe({ exceptionFactory: () => appError.notFound('Booking not found.') });

/** The booking as the app reads it (docs/app-api-phase3.md). */
export interface BookingReply {
  id: string;
  serviceType: string;
  serviceName: string;
  status: BookingStatus;
  windowStart: string;
  windowEnd: string;
  place: { lat: number; lng: number; label: string | null };
  notes: string | null;
  quote: { amountPaise: number; note: string | null; expiresAt: string | null } | null;
  rakshak: { firstName: string; etaMinutes: number | null } | null;
  matching: { state: 'searching' | 'offered' | 'no_match'; message: string } | null;
  canCancel: boolean;
  cancelMessage: string | null;
  history: { status: string; at: string; by: string }[];
  createdAt: string;
}

export const firstName = (name: string | null): string => name?.trim().split(/\s+/)[0] || 'Rakshak';

@Injectable()
export class BookingsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly settings: AppSettings,
  ) {}

  /** The staged-release switch: off means "not built yet" to the app (it shows "Not available yet"). */
  async requireFeature(key: 'feature.nearby' | 'feature.bookings'): Promise<void> {
    if ((await this.settings.get(key)) < 1) throw appError.notFound('Not available yet.');
  }

  async nearby(userId: string, query: { lat: number; lng: number; radiusM: number }) {
    await this.requireFeature('feature.nearby');
    const here = sql`ST_SetSRID(ST_MakePoint(${query.lng}, ${query.lat}), 4326)::geography`;
    const rows = await this.database.db
      .selectFrom('rakshak_presence as p')
      .innerJoin('users as u', 'u.id', 'p.user_id')
      .select([
        'p.user_id',
        'u.name',
        'p.updated_at',
        sql<number>`ST_Y(p.location::geometry)`.as('lat'),
        sql<number>`ST_X(p.location::geometry)`.as('lng'),
        sql<number>`ST_Distance(p.location, ${here})`.as('distance_m'),
      ])
      .where('p.online', '=', true)
      .where('u.status', '=', 'active')
      .where('p.user_id', '!=', userId)
      .where(sql<boolean>`p.updated_at > now() - make_interval(mins => ${PRESENCE_FRESH_MINUTES})`)
      .where(sql<boolean>`ST_DWithin(p.location, ${here}, ${query.radiusM})`)
      .where(
        sql<boolean>`EXISTS (SELECT 1 FROM rakshak_applications a
          WHERE a.user_id = p.user_id AND a.status = 'approved')`,
      )
      .orderBy(sql`distance_m`)
      .limit(20)
      .execute();
    return {
      // First name and an approximate position only (about 100 m). Never a phone number.
      items: rows.map((r) => ({
        id: r.user_id,
        firstName: firstName(r.name),
        lat: Math.round(r.lat * 1000) / 1000,
        lng: Math.round(r.lng * 1000) / 1000,
        distanceM: Math.round(r.distance_m / 10) * 10,
        etaMinutes: null,
        updatedAt: new Date(r.updated_at).toISOString(),
      })),
      refreshSeconds: NEARBY_REFRESH_SECONDS,
      maxRadiusM: NEARBY_MAX_RADIUS_M,
    };
  }

  async services() {
    await this.requireFeature('feature.bookings');
    const rows = await this.database.db
      .selectFrom('booking_services')
      .select(['id', 'name', 'description'])
      .where('active', '=', true)
      .orderBy('position')
      .execute();
    return rows;
  }

  async create(userId: string, input: z.infer<typeof createBody>): Promise<BookingReply> {
    await this.requireFeature('feature.bookings');
    const service = await this.database.db
      .selectFrom('booking_services')
      .select('id')
      .where('id', '=', input.serviceType)
      .where('active', '=', true)
      .executeTakeFirst();
    if (!service) throw appError.invalidInput('serviceType: Unknown service');
    if (new Date(input.windowEnd).getTime() < Date.now()) {
      throw appError.invalidInput('windowEnd: Choose a time in the future');
    }

    await this.database.db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('bookings')
        .select('user_id')
        .where('id', '=', input.id)
        .executeTakeFirst();
      // The same id again (a retry) returns the same booking; someone else's id is not found.
      if (existing) {
        if (existing.user_id !== userId) throw appError.notFound('Booking not found.');
        return;
      }
      const open = await trx
        .selectFrom('bookings')
        .select(sql<string>`count(*)`.as('n'))
        .where('user_id', '=', userId)
        .where('status', 'in', OPEN)
        .executeTakeFirstOrThrow();
      if (Number(open.n) >= MAX_OPEN_BOOKINGS) {
        throw appError.limitReached('You have too many open bookings. Please cancel one first.');
      }
      await trx
        .insertInto('bookings')
        .values({
          id: input.id,
          user_id: userId,
          service_type: input.serviceType,
          window_start: input.windowStart,
          window_end: input.windowEnd,
          place: sql<string>`ST_SetSRID(ST_MakePoint(${input.place.lng}, ${input.place.lat}), 4326)::geography`,
          place_label: input.place.label ?? null,
          notes: input.notes || null,
        })
        .execute();
      await trx
        .insertInto('booking_events')
        .values({
          booking_id: input.id,
          status: 'requested',
          actor: 'user',
          admin_id: null,
          note: null,
        })
        .execute();
    });
    return this.get(userId, input.id);
  }

  async list(userId: string): Promise<BookingReply[]> {
    await this.requireFeature('feature.bookings');
    const ids = await this.database.db
      .selectFrom('bookings')
      .select('id')
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();
    return Promise.all(ids.map((r) => this.get(userId, r.id)));
  }

  async get(userId: string, id: string): Promise<BookingReply> {
    const reply = await loadBooking(this.database, id, userId);
    if (!reply) throw appError.notFound('Booking not found.');
    return reply;
  }

  async acceptQuote(userId: string, id: string): Promise<BookingReply> {
    await this.requireFeature('feature.bookings');
    const current = await this.get(userId, id);
    if (current.status === 'confirmed') return current; // repeated tap
    if (current.status !== 'quoted' || !current.quote) {
      throw appError.conflict('There is no quote to accept.');
    }
    if (current.quote.expiresAt && new Date(current.quote.expiresAt) < new Date()) {
      throw appError.conflict('This quote has expired. Please ask for a new one.');
    }
    await this.change(id, 'quoted', 'confirmed', { note: 'Quote accepted' });
    return this.get(userId, id);
  }

  async declineQuote(userId: string, id: string): Promise<BookingReply> {
    await this.requireFeature('feature.bookings');
    const current = await this.get(userId, id);
    if (current.status === 'cancelled') return current;
    if (current.status !== 'quoted') throw appError.conflict('There is no quote to decline.');
    await this.change(id, 'quoted', 'cancelled', {
      note: 'Quote declined',
      reason: 'Quote declined',
    });
    return this.get(userId, id);
  }

  async cancel(userId: string, id: string, reason: string | null): Promise<BookingReply> {
    await this.requireFeature('feature.bookings');
    const current = await this.get(userId, id);
    if (current.status === 'cancelled') return current;
    if (!current.canCancel) throw appError.conflict('This booking can no longer be cancelled.');
    await this.change(id, current.status, 'cancelled', { note: reason, reason });
    return this.get(userId, id);
  }

  /** Moves a booking from one status to the next and records it. Only if it is still in `from`. */
  private async change(
    id: string,
    from: BookingStatus,
    to: BookingStatus,
    extra: { note?: string | null; reason?: string | null },
  ): Promise<void> {
    await this.database.db.transaction().execute(async (trx) => {
      const done = await trx
        .updateTable('bookings')
        .set({ status: to, ...(extra.reason !== undefined && { cancel_reason: extra.reason }) })
        .where('id', '=', id)
        .where('status', '=', from)
        .executeTakeFirst();
      if (done.numUpdatedRows === 0n)
        throw appError.conflict('This booking just changed. Please refresh.');
      await trx
        .insertInto('booking_events')
        .values({
          booking_id: id,
          status: to,
          actor: 'user',
          admin_id: null,
          note: extra.note ?? null,
        })
        .execute();
    });
  }
}

/** One booking with its history, the way the app and the admin panel both need it. */
export async function loadBooking(
  database: DatabaseService,
  id: string,
  userId?: string,
): Promise<BookingReply | undefined> {
  let q = database.db
    .selectFrom('bookings as b')
    .innerJoin('booking_services as s', 's.id', 'b.service_type')
    .leftJoin('users as r', 'r.id', 'b.rakshak_user_id')
    .select([
      'b.id',
      'b.service_type',
      's.name as service_name',
      'b.status',
      'b.window_start',
      'b.window_end',
      'b.place_label',
      'b.notes',
      'b.quote_amount_paise',
      'b.quote_note',
      'b.quote_expires_at',
      'b.created_at',
      'r.name as rakshak_name',
      'b.rakshak_user_id',
      sql<number>`ST_Y(b.place::geometry)`.as('lat'),
      sql<number>`ST_X(b.place::geometry)`.as('lng'),
    ])
    .where('b.id', '=', id);
  if (userId) q = q.where('b.user_id', '=', userId);
  const b = await q.executeTakeFirst();
  if (!b) return undefined;
  const events = await database.db
    .selectFrom('booking_events')
    .select(['status', 'actor', 'created_at'])
    .where('booking_id', '=', id)
    .orderBy('id')
    .execute();
  const hasRakshak = b.rakshak_user_id !== null;
  const searching = (b.status === 'requested' || b.status === 'confirmed') && !hasRakshak;
  return {
    id: b.id,
    serviceType: b.service_type,
    serviceName: b.service_name,
    status: b.status,
    windowStart: new Date(b.window_start).toISOString(),
    windowEnd: new Date(b.window_end).toISOString(),
    place: { lat: b.lat, lng: b.lng, label: b.place_label },
    notes: b.notes,
    quote:
      b.quote_amount_paise === null
        ? null
        : {
            amountPaise: b.quote_amount_paise,
            note: b.quote_note,
            expiresAt: b.quote_expires_at ? new Date(b.quote_expires_at).toISOString() : null,
          },
    rakshak: hasRakshak ? { firstName: firstName(b.rakshak_name), etaMinutes: null } : null,
    matching: searching ? { state: 'searching', message: 'Finding a Rakshak near you…' } : null,
    canCancel: b.status !== 'completed' && b.status !== 'cancelled',
    // No cancellation fee rules exist yet, so the server states none (the app never invents one).
    cancelMessage: null,
    history: events.map((e) => ({
      status: e.status,
      at: new Date(e.created_at).toISOString(),
      by: e.actor,
    })),
    createdAt: new Date(b.created_at).toISOString(),
  };
}

@Controller('v1')
export class BookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly limiter: AppRateLimiter,
  ) {}

  @Get('rakshaks/nearby')
  nearby(@Req() req: AppRequest, @Query() query: unknown) {
    return this.bookings.nearby(req.user!.id, parseAppBody(nearbyQuery, query));
  }

  @Get('booking/services')
  services() {
    return this.bookings.services();
  }

  @Post('bookings')
  @HttpCode(200)
  async create(@Req() req: AppRequest, @Body() body: unknown) {
    await this.limiter.check(`booking:${req.user!.id}`, 20, 60 * 60);
    return this.bookings.create(req.user!.id, parseAppBody(createBody, body));
  }

  @Get('bookings')
  list(@Req() req: AppRequest) {
    return this.bookings.list(req.user!.id);
  }

  @Get('bookings/:id')
  get(@Req() req: AppRequest, @Param('id', uuid) id: string) {
    return this.bookings.get(req.user!.id, id);
  }

  @Post('bookings/:id/quote/accept')
  @HttpCode(200)
  accept(@Req() req: AppRequest, @Param('id', uuid) id: string) {
    return this.bookings.acceptQuote(req.user!.id, id);
  }

  @Post('bookings/:id/quote/decline')
  @HttpCode(200)
  decline(@Req() req: AppRequest, @Param('id', uuid) id: string) {
    return this.bookings.declineQuote(req.user!.id, id);
  }

  @Post('bookings/:id/cancel')
  @HttpCode(200)
  cancel(@Req() req: AppRequest, @Param('id', uuid) id: string, @Body() body: unknown) {
    return this.bookings.cancel(req.user!.id, id, parseAppBody(cancelBody, body).reason ?? null);
  }
}
