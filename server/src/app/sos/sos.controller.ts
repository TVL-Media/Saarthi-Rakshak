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
import { CancelledSosRequest, EndSosRequest, StartSosRequest, type Sos } from '@sarthi/shared';
import { appError, parseAppBody, type AppRequest } from '../common/app-http';
import { SosService } from './sos.service';

interface StatusResponse {
  status(code: number): StatusResponse;
}

/** SOS works for every logged-in user, blocked ones included. */
@Controller('app/sos')
export class SosController {
  constructor(private readonly sos: SosService) {}

  @Post()
  @HttpCode(200)
  start(@Req() req: AppRequest, @Body() body: unknown): Promise<Sos> {
    return this.sos.start(req.user!.id, parseAppBody(StartSosRequest, body));
  }

  @Post('cancelled')
  @HttpCode(204)
  async cancelled(@Req() req: AppRequest, @Body() body: unknown): Promise<void> {
    await this.sos.reportCancelled(req.user!.id, parseAppBody(CancelledSosRequest, body));
  }

  @Get('active')
  async active(
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: StatusResponse,
  ): Promise<Sos | undefined> {
    const sos = await this.sos.active(req.user!.id);
    if (!sos) res.status(204);
    return sos ?? undefined;
  }

  @Post(':id/end')
  @HttpCode(200)
  end(
    @Req() req: AppRequest,
    @Param('id', new ParseUUIDPipe({ exceptionFactory: () => appError.notFound('SOS not found.') }))
    id: string,
    @Body() body: unknown,
  ): Promise<Sos> {
    parseAppBody(EndSosRequest, body);
    return this.sos.end(req.user!.id, id);
  }
}
