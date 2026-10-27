import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AdminsController } from '../admins/admins.controller';
import { AuditLogController } from '../audit/audit-log.controller';
import { HistoryController } from '../history/history.controller';
import { HistoryService } from '../history/history.service';
import { UsersController } from '../users/users.controller';
import { UsersService } from '../users/users.service';
import { AuditLogService } from '../audit/audit-log.service';
import { SettingsController } from '../settings/settings.controller';
import { SettingsService } from '../settings/settings.service';
import { AdminsService } from '../admins/admins.service';
import { AuditInterceptor } from '../audit/audit.interceptor';
import { AuditService } from '../audit/audit.service';
import { ENV } from '../config/env.module';
import type { Env } from '../config/env.schema';
import { AdminAuthGuard } from './admin-auth.guard';
import { AUTH_KEYS, deriveAuthKeys } from './auth-keys';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginRateLimiter } from './login-rate-limiter';
import { OriginGuard } from './origin.guard';
import { SessionsService } from './sessions.service';

/** Admin login, sessions, roles and audit for every /admin route. */
@Module({
  controllers: [
    AuthController,
    AdminsController,
    SettingsController,
    AuditLogController,
    UsersController,
    HistoryController,
  ],
  providers: [
    {
      provide: AUTH_KEYS,
      inject: [ENV],
      useFactory: (env: Env) => deriveAuthKeys(env.ADMIN_TOTP_ENCRYPTION_KEY),
    },
    AuditService,
    SessionsService,
    AuthService,
    AdminsService,
    SettingsService,
    AuditLogService,
    UsersService,
    HistoryService,
    LoginRateLimiter,
    // Order matters: the Origin check runs before the session check.
    { provide: APP_GUARD, useClass: OriginGuard },
    { provide: APP_GUARD, useClass: AdminAuthGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AuthModule {}
