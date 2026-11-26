import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ENV } from '../config/env.module';
import { activeConnections } from '../config/env.schema';
import type { Env } from '../config/env.schema';
import { AccountController } from './account/account.controller';
import { AccountService } from './account/account.service';
import { AudioController } from './audio/audio.controller';
import { AudioService } from './audio/audio.service';
import { DeliveryController } from './alerts/delivery.controller';
import { PushSender } from './alerts/push-sender';
import { SmsProviders } from './alerts/sms-providers';
import { BullJobQueue } from './jobs/bull-job-queue';
import { JobHandlers, JobQueue } from './jobs/job-queue';
import { JobsLifecycle } from './jobs/jobs-lifecycle';
import { ManualJobQueue } from './jobs/manual-job-queue';
import { CleanupService } from './timers/cleanup.service';
import { SafetyTimers } from './timers/safety-timers.service';
import { LiveController } from './live/live.controller';
import { LiveEvents } from './live/live-events';
import { LiveGateway } from './live/live.gateway';
import { LiveService } from './live/live.service';
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
import { AdminPhase2Controller, AdminPhase2Service } from './phase2/admin-phase2';
import { CommunityController, CommunityService } from './phase2/community';
import { DailyLocationController, DailyLocationService } from './phase2/daily-location';
import { GooglePlay, PlansController, PlansService } from './phase2/plans';
import { RakshakController, RakshakService } from './phase2/rakshak';
import { SosExtrasController, SosPhotosService, SosTriggersService } from './phase2/sos-extras';
import { VaultController, VaultService } from './phase2/vault';
import { AdminPhase3Controller, AdminPhase3Service } from './phase3/admin-phase3';
import { AdminSupportController, AdminSupportService } from './support/admin-support';
import { BookingsController, BookingsService } from './phase3/bookings';
import { AdminPhase4Controller, AdminPhase4Service } from './phase4/admin-phase4';
import { ChildController, ChildService } from './phase4/child';
import { Phase4Gate } from './phase4/common';
import { SafetyServicesController, SafetyServicesService } from './phase4/support';

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
    AudioController,
    DeliveryController,
    LiveController,
    SosExtrasController,
    DailyLocationController,
    VaultController,
    CommunityController,
    RakshakController,
    PlansController,
    AdminPhase2Controller,
    BookingsController,
    AdminPhase3Controller,
    SafetyServicesController,
    ChildController,
    AdminPhase4Controller,
    AdminSupportController,
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
    AudioService,
    SosTriggersService,
    SosPhotosService,
    DailyLocationService,
    VaultService,
    CommunityService,
    RakshakService,
    GooglePlay,
    PlansService,
    AdminPhase2Service,
    BookingsService,
    AdminPhase3Service,
    Phase4Gate,
    SafetyServicesService,
    ChildService,
    AdminPhase4Service,
    AdminSupportService,
    { provide: JobHandlers, useFactory: () => new JobHandlers() },
    {
      provide: JobQueue,
      inject: [ENV, JobHandlers],
      useFactory: (env: Env, handlers: JobHandlers) =>
        env.NODE_ENV === 'test'
          ? new ManualJobQueue(handlers)
          : new BullJobQueue(activeConnections(env).redisUrl, handlers),
    },
    JobsLifecycle,
    { provide: SmsProviders, inject: [ENV], useFactory: (env: Env) => SmsProviders.fromEnv(env) },
    { provide: PushSender, inject: [ENV], useFactory: (env: Env) => PushSender.fromEnv(env) },
    SafetyTimers,
    CleanupService,
    LiveEvents,
    LiveService,
    LiveGateway,
    AppSettings,
    OutgoingMessages,
    AppRateLimiter,
    { provide: APP_GUARD, useClass: AppAuthGuard },
    { provide: APP_FILTER, useClass: AppExceptionFilter },
  ],
})
export class UserAppModule {}
