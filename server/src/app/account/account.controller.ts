import { Body, Controller, Delete, HttpCode, Req } from '@nestjs/common';
import { DeleteAccountRequest } from '@sarthi/shared';
import { NoConsentNeeded } from '../auth/app-auth.decorators';
import { parseAppBody, type AppRequest } from '../common/app-http';
import { AccountService } from './account.service';

@Controller('v1')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @NoConsentNeeded()
  @Delete('me')
  @HttpCode(204)
  async delete(@Req() req: AppRequest, @Body() body: unknown): Promise<void> {
    await this.account.delete(req.user!.id, parseAppBody(DeleteAccountRequest, body));
  }
}
