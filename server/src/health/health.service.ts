import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.module';
import { RedisService } from '../redis/redis.module';

const CHECK_TIMEOUT_MS = 2000;

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
