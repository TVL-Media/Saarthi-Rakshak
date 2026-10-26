import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { HealthService, type HealthResult } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** 200 when PostgreSQL and Redis are both reachable, otherwise 503 showing which is down. */
  @Get()
  async get(): Promise<HealthResult> {
    const result = await this.health.check();
    if (result.status !== 'ok') throw new ServiceUnavailableException(result);
    return result;
  }
}
