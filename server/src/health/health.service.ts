import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.module';
import { RedisService } from '../redis/redis.module';

const CHECK_TIMEOUT_MS = 2000;
/** Slower than this (but not timed out) shows as "Slow" on the Dashboard. */
export const SLOW_CHECK_MS = 1000;

/** For the Dashboard: Working, Slow (over 1 second) or Down. */
export type HealthState = 'working' | 'slow' | 'down';

export type CheckStatus = 'up' | 'down';

export interface HealthResult {
  status: 'ok' | 'error';
  checks: { database: CheckStatus; redis: CheckStatus };
}

@Injectable()
export class HealthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
  ) {}

  /** Database and Redis with timing, for the Dashboard's System health card. */
  async detailed(): Promise<{ database: HealthState; redis: HealthState }> {
    const [database, redis] = await Promise.all([
      timedCheck(() => this.database.ping()),
      timedCheck(() => this.redis.ping()),
    ]);
    return { database, redis };
  }

  async check(): Promise<HealthResult> {
    const [database, redis] = await Promise.all([
      runCheck(() => this.database.ping()),
      runCheck(() => this.redis.ping()),
    ]);
    const status = database === 'up' && redis === 'up' ? 'ok' : 'error';
    return { status, checks: { database, redis } };
  }
}

/** Runs one check; anything slower than CHECK_TIMEOUT_MS counts as down. */
async function runCheck(check: () => Promise<void>): Promise<CheckStatus> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([check(), timeout]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

async function timedCheck(check: () => Promise<void>): Promise<HealthState> {
  const started = performance.now();
  if ((await runCheck(check)) === 'down') return 'down';
  return performance.now() - started > SLOW_CHECK_MS ? 'slow' : 'working';
}
