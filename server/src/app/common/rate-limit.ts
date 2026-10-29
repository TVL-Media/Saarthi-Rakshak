import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.module';
import { appError } from './app-http';

/** Counts attempts in Redis (shared by all servers). If Redis is down, the attempt is allowed. */
@Injectable()
export class AppRateLimiter {
  private readonly logger = new Logger(AppRateLimiter.name);

  constructor(private readonly redis: RedisService) {}

  /** Throws `too_many_requests` once `key` is used more than `limit` times in `windowSeconds`. */
  async check(key: string, limit: number, windowSeconds: number): Promise<void> {
    let count: number;
    try {
      const fullKey = `ratelimit:app:${key}`;
      count = await this.redis.client.incr(fullKey);
      if (count === 1) await this.redis.client.expire(fullKey, windowSeconds);
    } catch (err) {
      this.logger.error(`Rate limit check skipped: ${(err as Error).message}`);
      return;
    }
    if (count > limit) throw appError.tooManyRequests();
  }
}
