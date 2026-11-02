import { Logger } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { JobHandlers, JobQueue, type JobName, type JobOptions } from './job-queue';

/** The one BullMQ queue for all background jobs. */
export const QUEUE_NAME = 'sarthi-jobs';

/** Repeating jobs: lost-contact check every 30 seconds, cleanup every hour. */
export const REPEATING: { id: string; name: JobName; everyMs: number }[] = [
  { id: 'lost-contact-sweep', name: 'lost-contact-sweep', everyMs: 30_000 },
  { id: 'cleanup', name: 'cleanup', everyMs: 3_600_000 },
];

/** Jobs on Redis with BullMQ; the worker (if on) runs them in this process. */
export class BullJobQueue extends JobQueue {
  private readonly logger = new Logger('Jobs');
  private readonly connection: Redis;
  private readonly queue: Queue;
  private worker: Worker | null = null;
  private workerConnection: Redis | null = null;

  constructor(
    redisUrl: string,
    private readonly handlers: JobHandlers,
  ) {
    super();
    // BullMQ needs its own connection that never gives up on a command.
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.connection.on('error', () => undefined); // reported by RedisService already
    this.queue = new Queue(QUEUE_NAME, {
      connection: this.connection,
      defaultJobOptions: {
        // A job that throws (e.g. the database was down) is tried again a few times.
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 7 * 86_400 },
      },
    });
  }

  async add(name: JobName, data: Record<string, unknown>, options: JobOptions = {}): Promise<void> {
    await this.queue.add(name, data, {
      delay: options.delayMs && options.delayMs > 0 ? options.delayMs : undefined,
      jobId: options.jobId,
    });
  }

  /** Starts the worker and the repeating jobs. */
  async startWorker(): Promise<void> {
    for (const r of REPEATING) {
      await this.queue.upsertJobScheduler(r.id, { every: r.everyMs }, { name: r.name, data: {} });
    }
    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => this.handlers.run(job.name, job.data as Record<string, unknown>),
      {
        connection: (this.workerConnection = this.connection.duplicate({
          maxRetriesPerRequest: null,
        })),
        concurrency: 10,
      },
    );
    this.worker.on('failed', (job, err) => {
      this.logger.error(`Job ${job?.name ?? '?'} failed: ${err.message}`);
    });
    this.logger.log('Background worker started');
  }

  /** Waiting + delayed + active jobs (for health checks and tests). */
  async counts(): Promise<Record<string, number>> {
    return this.queue.getJobCounts('waiting', 'delayed', 'active', 'failed', 'completed');
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    // BullMQ does not close connections it was given.
    this.workerConnection?.disconnect();
    this.connection.disconnect();
  }
}
