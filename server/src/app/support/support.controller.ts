import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { SupportRequest } from '@sarthi/shared';
import { parseAppBody, type AppRequest } from '../common/app-http';
import { SupportService } from './support.service';

@Controller('v1/support-tickets')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Post()
  @HttpCode(204)
  async create(@Req() req: AppRequest, @Body() body: unknown): Promise<void> {
    await this.support.create(req.user!.id, parseAppBody(SupportRequest, body));
  }
}
