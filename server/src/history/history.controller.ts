import { BadRequestException, Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { z } from 'zod';
import { HistoryService } from './history.service';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'Use YYYY-MM-DD' });
const querySchema = z.object({
  type: z.enum(['all', 'sos', 'journey']).default('all'),
  real: z.enum(['all', 'real', 'test']).default('all'),
  outcome: z
    .enum([
      'active',
      'ended_safe',
      'cancelled',
      'arrived',
      'ended',
      'lost_contact',
      'turned_into_sos',
    ])
    .optional(),
  from: date.optional(),
  to: date.optional(),
  before: z.string().max(200).optional(),
});

/**
 * SOS & Journey History (both roles). Read-only: there is no route that edits, cancels or
 * deletes a record (rule 5). Every list and timeline view is written to the audit log.
 */
@Controller('admin/history')
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get()
  list(@Query() raw: unknown) {
    const result = querySchema.safeParse(raw ?? {});
    if (!result.success) throw new BadRequestException(result.error.issues[0].message);
    return this.history.list(result.data);
  }

  @Get('sos/:id')
  sosTimeline(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.history.timeline('sos', id);
  }

  @Get('journey/:id')
  journeyTimeline(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.history.timeline('journey', id);
  }
}
