import { JobHandlers, JobQueue, type JobName, type JobOptions } from './job-queue';

interface ManualJob {
  name: JobName;
  data: Record<string, unknown>;
  runAt: number;
  jobId?: string;
}

/**
 * For automated tests only (NODE_ENV=test): jobs wait in memory until the test runs them, so
 * timers can be tested without waiting minutes.
 */
export class ManualJobQueue extends JobQueue {
  readonly jobs: ManualJob[] = [];

  constructor(private readonly handlers: JobHandlers) {
    super();
  }

  add(name: JobName, data: Record<string, unknown>, options: JobOptions = {}): Promise<void> {
    if (options.jobId && this.jobs.some((j) => j.jobId === options.jobId)) {
      return Promise.resolve();
    }
    this.jobs.push({
      name,
      data,
      runAt: Date.now() + (options.delayMs ?? 0),
      jobId: options.jobId,
    });
    return Promise.resolve();
  }

  /** Jobs still waiting, optionally of one kind. */
  waiting(name?: JobName): ManualJob[] {
    return this.jobs.filter((j) => !name || j.name === name);
  }

  /**
   * Runs waiting jobs in time order, including jobs they add, as if the clock were `untilMs`
   * from now (default: only jobs due now). Delayed jobs later than that stay waiting.
   */
  async run(untilMs = 0): Promise<void> {
    for (let guard = 0; guard < 1000; guard++) {
      const limit = Date.now() + untilMs;
      const due = this.jobs.filter((j) => j.runAt <= limit).sort((a, b) => a.runAt - b.runAt)[0];
      if (!due) return;
      this.jobs.splice(this.jobs.indexOf(due), 1);
      await this.handlers.run(due.name, due.data);
    }
    throw new Error('ManualJobQueue: too many jobs (a job keeps adding jobs)');
  }

  /** Runs only jobs of one kind (and the jobs they add, if due). */
  async runOnly(name: JobName, untilMs = 0): Promise<void> {
    const limit = Date.now() + untilMs;
    const picked = this.jobs.filter((j) => j.name === name && j.runAt <= limit);
    for (const job of picked) {
      this.jobs.splice(this.jobs.indexOf(job), 1);
      await this.handlers.run(job.name, job.data);
    }
  }

  clear(): void {
    this.jobs.length = 0;
  }
}
