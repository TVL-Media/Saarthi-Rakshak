import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { NoAudit, Roles } from '../auth/auth.decorators';
import { parseBody, requestMeta, type HttpRequest } from '../common/http';
import { AdminsService } from './admins.service';

const reasonSchema = z.object({
  reason: z.string().trim().min(10, { error: 'Write a reason (at least 10 characters)' }).max(500),
});
const createSchema = z.object({
  name: z.string().max(200),
  email: z.string().max(320),
  role: z.enum(['super_admin', 'support_admin'], { error: 'Choose a role' }),
});

/** Admin Team (Super Admin only). */
@Roles('super_admin')
@Controller('admin/admins')
export class AdminsController {
  constructor(private readonly admins: AdminsService) {}

  @Get()
  list() {
    return this.admins.list();
  }

  // The routes below write their own named audit events. Their replies (with a temporary
  // password) are never logged anywhere.
  @NoAudit()
  @Post()
  @HttpCode(201)
  create(@Body() body: unknown, @Req() req: HttpRequest) {
    const input = parseBody(createSchema, body);
    return this.admins.create(req.admin!, input, requestMeta(req));
  }

  @NoAudit()
  @Post(':id/reset-password')
  @HttpCode(200)
  resetPassword(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: HttpRequest) {
    return this.admins.resetPassword(req.admin!, id, requestMeta(req));
  }

  @NoAudit()
  @Post(':id/remove')
  @HttpCode(204)
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @Req() req: HttpRequest,
  ): Promise<void> {
    const { reason } = parseBody(reasonSchema, body);
    await this.admins.remove(req.admin!, id, reason, requestMeta(req));
  }

  // Writes its own named audit event (admin.2fa_reset, with the reason).
  @NoAudit()
  @Post(':id/reset-2fa')
  @HttpCode(204)
  async resetTwoStep(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @Req() req: HttpRequest,
  ): Promise<void> {
    const { reason } = parseBody(reasonSchema, body);
    await this.admins.resetTwoStep(req.admin!, id, reason, requestMeta(req));
  }
}
