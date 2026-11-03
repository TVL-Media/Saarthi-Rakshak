import {
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { NoAudit, Passive } from '../auth/auth.decorators';
import { requestMeta, type HttpRequest } from '../common/http';
import { LiveSosService } from './live-sos.service';

/**
 * Live SOS (both roles). View only: there is no route that acts on an SOS. The panel refreshes
 * the list and the open SOS every 5 seconds; those refreshes are passive and not logged.
 * Opening the page, and opening each SOS (a person's live status), are logged.
 */
@Controller('admin/live')
export class LiveSosController {
  constructor(
    private readonly live: LiveSosService,
    private readonly audit: AuditService,
  ) {}

  @NoAudit()
  @Passive()
  @Get()
  list() {
    return this.live.list();
  }

  @NoAudit()
  @Passive()
  @Get(':id')
  async details(@Param('id', new ParseUUIDPipe()) id: string) {
    const details = await this.live.details(id);
    if (!details) throw new NotFoundException('SOS not found');
    return details;
  }

  /** Once per visit to the page. */
  @NoAudit()
  @Post('viewed')
  @HttpCode(204)
  async viewed(@Req() req: HttpRequest): Promise<void> {
    await this.audit.record(
      { action: 'live.viewed', admin_id: req.admin!.id, session_id: req.admin!.sessionId },
      requestMeta(req),
    );
  }

  /** Each time an admin opens one SOS's details. */
  @NoAudit()
  @Post(':id/viewed')
  @HttpCode(204)
  async sosViewed(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: HttpRequest,
  ): Promise<void> {
    await this.audit.record(
      {
        action: 'live_sos.viewed',
        admin_id: req.admin!.id,
        session_id: req.admin!.sessionId,
        target_type: 'sos',
        target_id: id,
      },
      requestMeta(req),
    );
  }
}
