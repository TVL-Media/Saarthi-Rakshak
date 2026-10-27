import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { NoAudit, Roles } from '../auth/auth.decorators';
import { parseBody, requestMeta, type HttpRequest } from '../common/http';
import { normaliseIndianMobile } from './phone';
import { UsersService } from './users.service';

const searchSchema = z.object({
  phone: z.string().max(30).optional(),
  setup: z.enum(['complete', 'unfinished']).optional(),
  status: z.enum(['active', 'blocked']).optional(),
  after: z.uuid().optional(),
});
const reasonSchema = z.object({
  reason: z.string().trim().min(10, { error: 'Write a reason (at least 10 characters)' }).max(500),
});

/** Users (both roles; "Delete data" is Super Admin only). Full phone numbers never leave here. */
@Controller('admin/users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The user list and phone search. A POST so the phone number stays out of web addresses,
   * browser history and logs. Written to the audit log as a view, without the number.
   */
  @NoAudit()
  @Post('search')
  @HttpCode(200)
  async search(@Body() body: unknown, @Req() req: HttpRequest) {
    const input = parseBody(searchSchema, body);
    let phone: string | undefined;
    if (input.phone?.trim()) {
      phone = normaliseIndianMobile(input.phone) ?? undefined;
      if (!phone) throw new BadRequestException('Enter the full 10-digit mobile number');
    }
    const result = await this.users.list({ ...input, phone });
    if (!input.after) {
      await this.audit.record(
        {
          action: 'users.searched',
          admin_id: req.admin!.id,
          session_id: req.admin!.sessionId,
          details: JSON.stringify({
            byPhone: Boolean(phone),
            setup: input.setup ?? null,
            status: input.status ?? null,
          }),
        },
        requestMeta(req),
      );
    }
    return result;
  }

  /** A profile view: written to the audit log by the audit step. */
  @Get(':id')
  profile(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.users.profile(id);
  }

  @NoAudit()
  @Post(':id/block')
  @HttpCode(204)
  async block(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @Req() req: HttpRequest,
  ) {
    const { reason } = parseBody(reasonSchema, body);
    await this.users.setBlocked(req.admin!, id, true, reason, requestMeta(req));
  }

  @NoAudit()
  @Post(':id/unblock')
  @HttpCode(204)
  async unblock(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @Req() req: HttpRequest,
  ) {
    const { reason } = parseBody(reasonSchema, body);
    await this.users.setBlocked(req.admin!, id, false, reason, requestMeta(req));
  }

  @Roles('super_admin')
  @NoAudit()
  @Post(':id/delete-data')
  @HttpCode(204)
  async deleteData(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @Req() req: HttpRequest,
  ) {
    const { reason } = parseBody(reasonSchema, body);
    await this.users.deleteData(req.admin!, id, reason, requestMeta(req));
  }
}
