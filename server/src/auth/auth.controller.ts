import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { z } from 'zod';
import { parseBody, requestMeta, type HttpRequest, type HttpResponse } from '../common/http';
import { AllowStages, NoAudit, Public } from './auth.decorators';
import { AuthService } from './auth.service';
import { clearedSessionCookie, sessionCookie } from './cookies';
import { LoginRateLimiter } from './login-rate-limiter';
import type { NewSession } from './sessions.service';

const loginSchema = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(200),
});
const passwordSchema = z.object({
  currentPassword: z.string().max(200).optional(),
  newPassword: z.string().max(200),
});
const codeSchema = z.object({ code: z.string().max(20) });
const verifySchema = z
  .object({ code: z.string().max(20).optional(), backupCode: z.string().max(40).optional() })
  .refine((b) => (b.code === undefined) !== (b.backupCode === undefined), {
    error: 'Give either code or backupCode',
  });

function setSession(res: HttpResponse, session: NewSession): void {
  res.setHeader('Set-Cookie', sessionCookie(session.token, session.maxAgeSeconds));
}

// Every route here writes its own named audit events, so no per-request row.
@NoAudit()
@Controller('admin/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly rateLimiter: LoginRateLimiter,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    const meta = requestMeta(req);
    await this.rateLimiter.check(meta.ip);
    const { email, password } = parseBody(loginSchema, body);
    const { session, next } = await this.auth.login(email, password, meta);
    setSession(res, session);
    return { next };
  }

  @AllowStages('change_password', 'full')
  @Post('password')
  @HttpCode(200)
  async changePassword(
    @Body() body: unknown,
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    const input = parseBody(passwordSchema, body);
    const result = await this.auth.changePassword(req.admin!, input, requestMeta(req));
    if (result.session) setSession(res, result.session);
    return { next: result.next };
  }

  @AllowStages('setup_2fa')
  @Post('2fa/setup')
  @HttpCode(200)
  startTotpSetup(@Req() req: HttpRequest) {
    return this.auth.startTotpSetup(req.admin!, requestMeta(req));
  }

  @AllowStages('setup_2fa')
  @Post('2fa/setup/confirm')
  @HttpCode(200)
  async confirmTotpSetup(
    @Body() body: unknown,
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    const meta = requestMeta(req);
    await this.rateLimiter.check(meta.ip);
    const { code } = parseBody(codeSchema, body);
    const { session, backupCodes } = await this.auth.confirmTotpSetup(req.admin!, code, meta);
    setSession(res, session);
    return { next: 'done', backupCodes };
  }

  @AllowStages('verify_2fa')
  @Post('2fa/verify')
  @HttpCode(200)
  async verify(
    @Body() body: unknown,
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    const meta = requestMeta(req);
    await this.rateLimiter.check(meta.ip);
    const input = parseBody(verifySchema, body);
    const { session, backupCodesLeft } = await this.auth.verifySecondFactor(
      req.admin!,
      input,
      meta,
    );
    setSession(res, session);
    return { next: 'done', backupCodesLeft };
  }

  @Post('2fa/backup-codes')
  @HttpCode(200)
  async regenerateBackupCodes(@Body() body: unknown, @Req() req: HttpRequest) {
    const { code } = parseBody(codeSchema, body);
    return {
      backupCodes: await this.auth.regenerateBackupCodes(req.admin!, code, requestMeta(req)),
    };
  }

  /** Polled by the panel in the background, so never audited. */
  @Get('me')
  me(@Req() req: HttpRequest) {
    return this.auth.me(req.admin!);
  }

  @AllowStages('change_password', 'setup_2fa', 'verify_2fa', 'full')
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: HttpRequest, @Res({ passthrough: true }) res: HttpResponse) {
    await this.auth.logout(req.admin!, requestMeta(req));
    res.setHeader('Set-Cookie', clearedSessionCookie());
  }
}
