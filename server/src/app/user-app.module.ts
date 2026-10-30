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
import { AppSettings } from './common/app-settings';
import { GuardiansController, InviteController } from './guardians/guardians.controller';
import { GuardiansService } from './guardians/guardians.service';
import { OutgoingMessages } from './messages/outgoing-messages';
import { ProfileController } from './profile/profile.controller';
import { ProfileService } from './profile/profile.service';
import { SosController } from './sos/sos.controller';
import { SosService } from './sos/sos.service';

/** Everything the Android app and the guardian pages call: /app/... and /g/... */
@Module({
  controllers: [
    AppAuthController,
    ProfileController,
    GuardiansController,
    InviteController,
    SosController,
  ],
  providers: [
    {
      provide: PhoneTokenVerifier,
      inject: [ENV],
      useFactory: (env: Env) => phoneTokenVerifierFor(env),
    },
    UserSessionsService,
    AppAuthService,
    ProfileService,
    GuardiansService,
    SosService,
    AppSettings,
    OutgoingMessages,
    AppRateLimiter,
    { provide: APP_GUARD, useClass: AppAuthGuard },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
  ],
})
export class UserAppModule {}
