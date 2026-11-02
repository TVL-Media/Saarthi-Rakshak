import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ENV } from '../config/env.module';
import type { Env } from '../config/env.schema';
import { AccountController } from './account/account.controller';
import { AccountService } from './account/account.service';
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
import { HistoryController } from './history/history.controller';
import { HistoryService } from './history/history.service';
import { PlacesController } from './places/places.controller';
import { PlacesService } from './places/places.service';
import { SupportController } from './support/support.controller';
import { SupportService } from './support/support.service';
import { JourneysController } from './journeys/journeys.controller';
import { JourneysService } from './journeys/journeys.service';
import { LocationsController } from './locations/locations.controller';
import { LocationsService } from './locations/locations.service';
import { SosController } from './sos/sos.controller';
import { SosService } from './sos/sos.service';

/** Everything the Android app and the guardian pages call: /v1/... and /g/... */
@Module({
  controllers: [
    AppAuthController,
    ProfileController,
    GuardiansController,
    InviteController,
    SosController,
    LocationsController,
    JourneysController,
    HistoryController,
    PlacesController,
    SupportController,
    AccountController,
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
    LocationsService,
    JourneysService,
    HistoryService,
    PlacesService,
    SupportService,
    AccountService,
    AppSettings,
    OutgoingMessages,
    AppRateLimiter,
    { provide: APP_GUARD, useClass: AppAuthGuard },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
  ],
})
export class UserAppModule {}
