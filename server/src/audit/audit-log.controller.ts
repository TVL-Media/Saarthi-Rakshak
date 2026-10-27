import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../auth/auth.decorators';
import { AuditLogService } from './audit-log.service';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'Use YYYY-MM-DD' });
const querySchema = z.object({
  admin: z.uuid({ error: 'Unknown admin' }).optional(),
  kind: z.enum(['all', 'changes', 'logins']).default('all'),
  from: date.optional(),
  to: date.optional(),
  before: z.string().regex(/^\d+$/, { error: 'Invalid page' }).optional(),
});

/** Audit Log (Super Admin only). Read-only: no route changes or deletes entries. */
@Roles('super_admin')
@Controller('admin/audit')
export class AuditLogController {
  constructor(private readonly auditLog: AuditLogService) {}

  /** Opening the log is itself a view, written to the log by the audit step. */
  @Get()
  list(@Query() raw: unknown) {
    const result = querySchema.safeParse(raw ?? {});
    if (!result.success) throw new BadRequestException(result.error.issues[0].message);
    const { admin, kind, from, to, before } = result.data;
    return this.auditLog.list({ adminId: admin, kind, from, to, before });
  }
}
