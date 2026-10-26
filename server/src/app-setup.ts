import type { INestApplication } from '@nestjs/common';
import type { Env } from './config/env.schema';

/** Settings shared by the real server (main.ts) and the end-to-end tests. */
export function configureApp(app: INestApplication, env: Env): void {
  // Strict CORS: only the admin panel's origin may call the API from a browser, with cookies.
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) =>
      callback(null, origin === env.ADMIN_PANEL_ORIGIN),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type'],
    maxAge: 600,
  });

  // Behind DigitalOcean's load balancer the client's address comes from X-Forwarded-For.
  if (env.NODE_ENV === 'production') {
    const express = app.getHttpAdapter().getInstance() as {
      set(key: string, value: unknown): void;
    };
    express.set('trust proxy', 1);
  }
}
