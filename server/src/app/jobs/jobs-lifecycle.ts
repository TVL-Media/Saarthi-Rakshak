import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ENV } from '../../config/env.module';
import type { Env } from '../../config/env.schema';
import { BullJobQueue } from './bull-job-queue';
import { JobQueue } from './job-queue';

/** Starts the background worker when the server is ready (WORKER=on), and stops it cleanly. */
@Injectable()
export class JobsLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly queue: JobQueue,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.queue instanceof BullJobQueue && this.env.WORKER === 'on') {
      await this.queue.startWorker();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.queue instanceof BullJobQueue) await this.queue.close();
  }
}
