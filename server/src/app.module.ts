import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { EnvModule } from './config/env.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { RedisModule } from './redis/redis.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [EnvModule, DatabaseModule, RedisModule, StorageModule, AuthModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class AppModule {}
