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
import { z } from 'zod';
import { parseBody, type HttpRequest } from '../../common/http';
import { DatabaseService } from '../../database/database.module';
import { maskPhone } from '../phase2/admin-phase2';

// Admin screen 6: Support Tickets ("Report a problem" in the app). Both admin roles may use it.
// Every view and change is written to the audit log by the global AuditInterceptor; the phone
// number is always partly masked. Replies to the user are not built yet (no way to show them).

const PAGE = 50;
const STATUSES = ['open', 'in_progress', 'closed'] as const;
type TicketStatus = (typeof STATUSES)[number];

const listQuery = z.object({
  status: z.enum(STATUSES).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
});
const statusBody = z.object({ status: z.enum(STATUSES) });
const assignBody = z.object({ toMe: z.boolean() });

const uuid = new ParseUUIDPipe({ exceptionFactory: () => new NotFoundException('Not found') });

@Injectable()
export class AdminSupportService {
  constructor(private readonly database: DatabaseService) {}

  async list(status?: TicketStatus, before?: string) {
    let q = this.database.db
      .selectFrom('support_tickets as t')
      .innerJoin('users as u', 'u.id', 't.user_id')
      .leftJoin('admins as a', 'a.id', 't.assigned_admin_id')
      .select([
        't.id',
        't.category',
        't.message',
        't.status',
        't.created_at',
        'u.id as user_id',
        'u.name as user_name',
        'u.phone as user_phone',
        'a.name as assigned_name',
      ]);
    if (status) q = q.where('t.status', '=', status);
    if (before) q = q.where('t.created_at', '<', new Date(before));
    const rows = await q
      .orderBy('t.created_at', 'desc')
      .limit(PAGE + 1)
      .execute();
    const counts = await this.database.db
      .selectFrom('support_tickets')
      .select(['status'])
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .groupBy('status')
      .execute();
    return {
      items: rows.slice(0, PAGE).map((r) => ({
        id: r.id,
        category: r.category,
        // The list shows the start of the message only; the ticket shows all of it.
        preview: r.message.length > 80 ? `${r.message.slice(0, 80)}…` : r.message,
        status: r.status,
        userId: r.user_id,
        userName: r.user_name,
        userPhone: maskPhone(r.user_phone),
        assignedTo: r.assigned_name,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      more: rows.length > PAGE,
      counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
    };
  }

  async detail(id: string) {
    const r = await this.database.db
      .selectFrom('support_tickets as t')
      .innerJoin('users as u', 'u.id', 't.user_id')
      .leftJoin('admins as a', 'a.id', 't.assigned_admin_id')
      .select([
        't.id',
        't.category',
        't.message',
        't.status',
        't.app_version',
        't.device_model',
        't.created_at',
        't.closed_at',
        't.assigned_admin_id',
        'u.id as user_id',
        'u.name as user_name',
        'u.phone as user_phone',
        'a.name as assigned_name',
      ])
      .where('t.id', '=', id)
      .executeTakeFirst();
    if (!r) throw new NotFoundException('Not found');
    return {
      id: r.id,
      category: r.category,
      message: r.message,
      status: r.status,
      appVersion: r.app_version,
      deviceModel: r.device_model,
      createdAt: new Date(r.created_at).toISOString(),
      closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
      assignedAdminId: r.assigned_admin_id,
      assignedTo: r.assigned_name,
      user: { id: r.user_id, name: r.user_name, phone: maskPhone(r.user_phone) },
    };
  }

  /** New / In progress / Resolved. Resolving records the time; reopening clears it. */
  async setStatus(id: string, status: TicketStatus) {
    const row = await this.database.db
      .updateTable('support_tickets')
      .set({ status, closed_at: status === 'closed' ? new Date() : null })
      .where('id', '=', id)
      .returning('id')
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Not found');
    return this.detail(id);
  }

  /** "Assign to me" or "Unassign". Taking a new ticket also moves it to In progress. */
  async assign(adminId: string, id: string, toMe: boolean) {
    await this.database.db.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable('support_tickets')
        .set({ assigned_admin_id: toMe ? adminId : null })
        .where('id', '=', id)
        .returning('id')
        .executeTakeFirst();
      if (!row) throw new NotFoundException('Not found');
      if (toMe) {
        await trx
          .updateTable('support_tickets')
          .set({ status: 'in_progress' })
          .where('id', '=', id)
          .where('status', '=', 'open')
          .execute();
      }
    });
    return this.detail(id);
  }
}

@Controller('admin/support-tickets')
export class AdminSupportController {
  constructor(private readonly service: AdminSupportService) {}

  @Get()
  list(@Query() query: unknown) {
    const q = parseBody(listQuery, query);
    return this.service.list(q.status, q.before);
  }

  @Get(':id')
  detail(@Param('id', uuid) id: string) {
    return this.service.detail(id);
  }

  @Post(':id/status')
  @HttpCode(200)
  status(@Param('id', uuid) id: string, @Body() body: unknown) {
    return this.service.setStatus(id, parseBody(statusBody, body).status);
  }

  @Post(':id/assign')
  @HttpCode(200)
  assign(@Req() req: HttpRequest, @Param('id', uuid) id: string, @Body() body: unknown) {
    return this.service.assign(req.admin!.id, id, parseBody(assignBody, body).toMe);
  }
}
