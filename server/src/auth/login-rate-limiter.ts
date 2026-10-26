import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.module';
import { IP_ATTEMPT_LIMIT, IP_WINDOW_MINUTES } from './auth.constants';

/** Login and 2-step attempts per IP address, counted in Redis (shared by all servers). */
@Injectable()
export class LoginRateLimiter {
  private readonly logger = new Logger(LoginRateLimiter.name);

  constructor(private readonly redis: RedisService) {}

  async check(ip: string | null): Promise<void> {
    if (!ip) return;
    const key = `ratelimit:admin-login:${ip}`;
    let attempts: number;
    try {
      attempts = await this.redis.client.incr(key);
      if (attempts === 1) await this.redis.client.expire(key, IP_WINDOW_MINUTES * 60);
    } catch (err) {
      // Redis down: allow the attempt. Account lockout (in PostgreSQL) still applies.
      this.logger.error(`Rate limit check skipped: ${(err as Error).message}`);
      return;
    }
    if (attempts > IP_ATTEMPT_LIMIT) {
      throw new HttpException('Too many attempts. Try again later.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
