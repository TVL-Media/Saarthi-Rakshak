import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import { HistoryQuery, type HistoryDetail, type HistoryPage } from '@sarthi/shared';
import { appError, parseAppBody, type AppRequest } from '../common/app-http';
import { HistoryService } from './history.service';

const uuid = (what: string) =>
  new ParseUUIDPipe({ exceptionFactory: () => appError.notFound(`${what} not found.`) });

@Controller('v1/history')
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get()
  list(@Req() req: AppRequest, @Query() query: unknown): Promise<HistoryPage> {
    return this.history.list(req.user!.id, parseAppBody(HistoryQuery, query));
  }

  @Get('sos/:id')
  sos(@Req() req: AppRequest, @Param('id', uuid('SOS')) id: string): Promise<HistoryDetail> {
    return this.history.sos(req.user!.id, id);
  }

  @Get('journeys/:id')
  journey(
    @Req() req: AppRequest,
    @Param('id', uuid('Journey')) id: string,
  ): Promise<HistoryDetail> {
    return this.history.journey(req.user!.id, id);
  }
}
