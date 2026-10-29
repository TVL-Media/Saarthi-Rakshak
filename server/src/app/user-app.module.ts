import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ENV } from '../config/env.module';
import type { Env } from '../config/env.schema';
import { AppAuthController } from './auth/app-auth.controller';
import { AppAuthGuard } from './auth/app-auth.guard';
import { AppAuthService } from './auth/app-auth.service';
import { PhoneTokenVerifier, phoneTokenVerifierFor } from './auth/phone-token-verifier';
import { UserSessionsService } from './auth/user-sessions.service';
import { AppExceptionFilter } from './common/app-exception.filter';
import { AppRateLimiter } from './common/rate-limit';

/** Everything the Android app and the guardian pages call: /app/... and /g/... */
@Module({
  controllers: [AppAuthController],
  providers: [
    {
      provide: PhoneTokenVerifier,
      inject: [ENV],
      useFactory: (env: Env) => phoneTokenVerifierFor(env),
    },
    UserSessionsService,
    AppAuthService,
    AppRateLimiter,
    { provide: APP_GUARD, useClass: AppAuthGuard },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
  ],
})
export class UserAppModule {}
