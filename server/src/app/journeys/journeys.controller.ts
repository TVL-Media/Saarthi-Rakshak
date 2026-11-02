import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  AnswerCheckinRequest,
  EndJourneyRequest,
  RaiseCheckinRequest,
  StartJourneyRequest,
  type Checkin,
  type Journey,
} from '@sarthi/shared';
import { appError, parseAppBody, type AppRequest } from '../common/app-http';
import { JourneysService } from './journeys.service';

interface StatusResponse {
  status(code: number): StatusResponse;
}

const uuid = (what: string) =>
  new ParseUUIDPipe({ exceptionFactory: () => appError.notFound(`${what} not found.`) });

@Controller('v1')
export class JourneysController {
  constructor(private readonly journeys: JourneysService) {}

  @Post('journeys')
  @HttpCode(200)
  start(@Req() req: AppRequest, @Body() body: unknown): Promise<Journey> {
    return this.journeys.start(req.user!.id, parseAppBody(StartJourneyRequest, body));
  }

  @Get('journeys/active')
  async active(
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: StatusResponse,
  ): Promise<Journey | undefined> {
    const journey = await this.journeys.active(req.user!.id);
    if (!journey) res.status(204);
    return journey ?? undefined;
  }

  @Get('journeys/:id')
  one(@Req() req: AppRequest, @Param('id', uuid('Journey')) id: string): Promise<Journey> {
    return this.journeys.get(req.user!.id, id);
  }

  @Post('journeys/:id/end')
  @HttpCode(200)
  end(
    @Req() req: AppRequest,
    @Param('id', uuid('Journey')) id: string,
    @Body() body: unknown,
  ): Promise<Journey> {
    return this.journeys.end(req.user!.id, id, parseAppBody(EndJourneyRequest, body));
  }

  @Post('journeys/:id/checkins')
  @HttpCode(200)
  raise(
    @Req() req: AppRequest,
    @Param('id', uuid('Journey')) id: string,
    @Body() body: unknown,
  ): Promise<Checkin> {
    return this.journeys.raiseCheckin(req.user!.id, id, parseAppBody(RaiseCheckinRequest, body));
  }

  @Post('checkins/:id/answer')
  @HttpCode(200)
  answer(
    @Req() req: AppRequest,
    @Param('id', uuid('Check-in')) id: string,
    @Body() body: unknown,
  ): Promise<Checkin> {
    return this.journeys.answerCheckin(req.user!.id, id, parseAppBody(AnswerCheckinRequest, body));
  }
}
