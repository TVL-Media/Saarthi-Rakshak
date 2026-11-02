import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.module';
import { liveKeys } from '../locations/live-location';

/** Tells open live pages that something changed, so they reload (through Redis, for all servers). */
@Injectable()
export class LiveEvents {
  private readonly logger = new Logger('LiveEvents');

  constructor(private readonly redis: RedisService) {}

  async changed(kind: 'sos' | 'journey', id: string): Promise<void> {
    try {
      await this.redis.client.publish(liveKeys.status(kind, id), '{}');
    } catch (err) {
      // Pages also reload every minute; a missed event is not fatal.
      this.logger.error(`Live update not published: ${(err as Error).message}`);
    }
  }
}
