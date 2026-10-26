import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { NoAudit, Roles } from '../auth/auth.decorators';
import { parseBody, requestMeta, type HttpRequest } from '../common/http';
import { AdminsService } from './admins.service';

const resetSchema = z.object({
  reason: z.string().trim().min(10, { error: 'Write a reason (at least 10 characters)' }).max(500),
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

  // Writes its own named audit event (admin.2fa_reset, with the reason).
  @NoAudit()
  @Post(':id/reset-2fa')
  @HttpCode(204)
  async resetTwoStep(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @Req() req: HttpRequest,
  ): Promise<void> {
    const { reason } = parseBody(resetSchema, body);
    await this.admins.resetTwoStep(req.admin!, id, reason, requestMeta(req));
  }
}
