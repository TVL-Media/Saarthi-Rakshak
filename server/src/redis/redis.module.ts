import { Global, Inject, Injectable, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { ENV } from '../config/env.module';
import { activeConnections, type Env } from '../config/env.schema';

export const REDIS_URL = Symbol('REDIS_URL');

@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  private reportedDown = false;
  readonly client: Redis;

  constructor(@Inject(REDIS_URL) url: string) {
    // Commands wait for the connection, but give up after one reconnect attempt while Redis is down.
    this.client = new Redis(url, { maxRetriesPerRequest: 1 });
    // Log once per outage, not on every reconnect attempt.
    this.client.on('error', (err) => {
      if (!this.reportedDown) this.logger.error(`Redis error: ${err.message}`);
      this.reportedDown = true;
    });
    this.client.on('ready', () => {
      this.reportedDown = false;
    });
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  onApplicationShutdown(): void {
    this.client.disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_URL,
      inject: [ENV],
      useFactory: (env: Env) => activeConnections(env).redisUrl,
    },
    RedisService,
  ],
  exports: [RedisService],
})
export class RedisModule {}
