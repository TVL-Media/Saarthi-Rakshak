import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Server as HttpServer } from 'node:http';
import Redis from 'ioredis';
import { Server } from 'socket.io';
import { ENV } from '../../config/env.module';
import { activeConnections, type Env } from '../../config/env.schema';
import { LiveService } from './live.service';

/** Socket.IO path, under /g so one proxy rule covers the page's API and live updates. */
export const LIVE_SOCKET_PATH = '/g/socket.io';

/**
 * Live updates for guardian pages (web only; the user's phone gets push notifications instead).
 * A page connects with its link code and joins the room of that SOS or journey. Events to the
 * page: `ready` (joined), `location` (a new LivePoint), `changed` (reload the page data) and
 * `ended` (the link does not work: reload shows "This alert has ended").
 */
@Injectable()
export class LiveGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('LiveGateway');
  private io: Server | null = null;
  private subscriber: Redis | null = null;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly live: LiveService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    const httpServer = this.adapterHost.httpAdapter?.getHttpServer() as HttpServer | undefined;
    if (!httpServer) return;

    this.io = new Server(httpServer, {
      path: LIVE_SOCKET_PATH,
      serveClient: false,
      // The page is served from GUARDIAN_WEB_URL (or through its proxy in development).
      cors: { origin: new URL(this.env.GUARDIAN_WEB_URL).origin },
    });
    this.io.on('connection', (socket) => {
      const code = (socket.handshake.auth as { code?: unknown } | undefined)?.code;
      if (typeof code !== 'string') {
        socket.emit('ended');
        socket.disconnect(true);
        return;
      }
      this.live
        .findOpenLink(code)
        .then(async (link) => {
          await socket.join(`${link.kind}:${link.id}`);
          socket.emit('ready');
        })
        .catch(() => {
          socket.emit('ended');
          socket.disconnect(true);
        });
    });

    // Every server hears every change through Redis and passes it to its own pages.
    this.subscriber = new Redis(activeConnections(this.env).redisUrl);
    this.subscriber.on('error', () => undefined); // reported by RedisService already
    void this.subscriber
      .psubscribe('sos:*:location', 'journey:*:location', 'sos:*:status', 'journey:*:status')
      .catch((err: Error) => this.logger.error(`Live updates off: ${err.message}`));
    this.subscriber.on('pmessage', (_pattern, channel, message) => {
      const [kind, id, what] = channel.split(':');
      const room = `${kind}:${id}`;
      if (what === 'location') {
        try {
          this.io?.to(room).emit('location', JSON.parse(message) as unknown);
        } catch {
          // ignore a broken message
        }
      } else {
        this.io?.to(room).emit('changed');
      }
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.subscriber?.disconnect();
    // Not io.close(): that would also close the HTTP server, which Nest closes itself.
    this.io?.disconnectSockets(true);
    this.io?.engine.close();
    return Promise.resolve();
  }
}
