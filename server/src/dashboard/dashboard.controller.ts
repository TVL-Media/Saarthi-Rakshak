import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { NoAudit, Passive } from '../auth/auth.decorators';
import { requestMeta, type HttpRequest } from '../common/http';
import { DashboardService } from './dashboard.service';

/** Dashboard (both roles). */
@Controller('admin/dashboard')
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The numbers. The panel refreshes this every 30 seconds, so it is not written to the audit
   * log and does not count as activity (it must never keep an idle session alive).
   */
  @NoAudit()
  @Passive()
  @Get()
  summary() {
    return this.dashboard.summary();
  }

  /** Called once when the Dashboard is opened: one audit entry per visit, and counts as activity. */
  @NoAudit()
  @Post('viewed')
  @HttpCode(204)
  async viewed(@Req() req: HttpRequest): Promise<void> {
    await this.audit.record(
      { action: 'dashboard.viewed', admin_id: req.admin!.id, session_id: req.admin!.sessionId },
      requestMeta(req),
    );
  }
}
