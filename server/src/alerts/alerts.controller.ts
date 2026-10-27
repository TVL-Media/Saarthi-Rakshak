import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { AlertsService } from './alerts.service';

const querySchema = z.object({ before: z.string().max(200).optional() });

/** Alert Log (both roles). Read-only; every view is written to the audit log. */
@Controller('admin/alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  async list(@Query() raw: unknown) {
    const result = querySchema.safeParse(raw ?? {});
    if (!result.success) throw new BadRequestException(result.error.issues[0].message);
    const [page, counts] = await Promise.all([
      this.alerts.list(result.data.before),
      result.data.before ? Promise.resolve(null) : this.alerts.counts(),
    ]);
    return { ...page, counts };
  }
}
