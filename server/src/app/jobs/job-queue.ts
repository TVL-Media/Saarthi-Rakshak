/** Background jobs. Each name has one handler (registered with JobHandlers). */
export type JobName =
  'sms' | 'push' | 'sos-no-response' | 'checkin-reply' | 'lost-contact-sweep' | 'cleanup';

export interface JobOptions {
  /** Run no earlier than this many milliseconds from now. */
  delayMs?: number;
  /** A job with the same id is added only once. Letters, digits and '-' only (BullMQ refuses ':'). */
  jobId?: string;
}

/** Where jobs are added: BullMQ on Redis (BullJobQueue), or ManualJobQueue in tests. */
export abstract class JobQueue {
  abstract add(name: JobName, data: Record<string, unknown>, options?: JobOptions): Promise<void>;
}

type Handler = (data: Record<string, unknown>) => Promise<void>;

/** The code that runs each kind of job. Services register their handlers when they start. */
export class JobHandlers {
  private readonly handlers = new Map<JobName, Handler>();

  register(name: JobName, handler: Handler): void {
    if (this.handlers.has(name)) throw new Error(`Job handler for "${name}" registered twice`);
    this.handlers.set(name, handler);
  }

  async run(name: string, data: Record<string, unknown>): Promise<void> {
    const handler = this.handlers.get(name as JobName);
    if (!handler) throw new Error(`No handler for job "${name}"`);
    await handler(data);
  }
}
