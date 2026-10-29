import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { AddGuardianRequest, type Guardian, type InviteInfo } from '@sarthi/shared';
import { appError, parseAppBody, type AppRequest } from '../common/app-http';
import { AppRateLimiter } from '../common/rate-limit';
import { AppPublic } from '../auth/app-auth.decorators';
import { GuardiansService } from './guardians.service';

/** Invite-link calls per IP address per minute (the link pages, no login). */
export const INVITE_PAGE_LIMIT_PER_MINUTE = 30;

const guardianId = new ParseUUIDPipe({
  exceptionFactory: () => appError.notFound('Guardian not found.'),
});

@Controller('app/guardians')
export class GuardiansController {
  constructor(private readonly guardians: GuardiansService) {}

  @Get()
  list(@Req() req: AppRequest): Promise<Guardian[]> {
    return this.guardians.list(req.user!.id);
  }

  @Post()
  add(@Req() req: AppRequest, @Body() body: unknown): Promise<Guardian> {
    const input = parseAppBody(AddGuardianRequest, body);
    return this.guardians.add(req.user!.id, req.user!.status === 'blocked', input);
  }

  @Post(':id/resend')
  @HttpCode(204)
  async resend(@Req() req: AppRequest, @Param('id', guardianId) id: string): Promise<void> {
    await this.guardians.resend(req.user!.id, req.user!.status === 'blocked', id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: AppRequest, @Param('id', guardianId) id: string): Promise<void> {
    await this.guardians.remove(req.user!.id, id);
  }
}

/** The guardian's invite page calls these with the code from the SMS link (no login). */
@AppPublic()
@Controller('g/invite')
export class InviteController {
  constructor(
    private readonly guardians: GuardiansService,
    private readonly rateLimiter: AppRateLimiter,
  ) {}

  private limit(req: AppRequest): Promise<void> {
    return this.rateLimiter.check(
      `invite-page:${req.ip ?? 'unknown'}`,
      INVITE_PAGE_LIMIT_PER_MINUTE,
      60,
    );
  }

  @Get(':code')
  async info(@Req() req: AppRequest, @Param('code') code: string): Promise<InviteInfo> {
    await this.limit(req);
    return this.guardians.inviteInfo(code);
  }

  @Post(':code/accept')
  @HttpCode(204)
  async accept(@Req() req: AppRequest, @Param('code') code: string): Promise<void> {
    await this.limit(req);
    await this.guardians.accept(code);
  }

  @Post(':code/decline')
  @HttpCode(204)
  async decline(@Req() req: AppRequest, @Param('code') code: string): Promise<void> {
    await this.limit(req);
    await this.guardians.decline(code);
  }
}
