import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { DATABASE_URL, DatabaseService } from '../src/database/database.module';
import { REDIS_URL } from '../src/redis/redis.module';

// Nothing listens on port 1, so connections there always fail.
const CLOSED_DATABASE_URL = 'postgresql://sarthi:x@127.0.0.1:1/none';
const CLOSED_REDIS_URL = 'redis://127.0.0.1:1/1';

async function startApp(overrides: { databaseUrl?: string; redisUrl?: string } = {}) {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (overrides.databaseUrl) builder.overrideProvider(DATABASE_URL).useValue(overrides.databaseUrl);
  if (overrides.redisUrl) builder.overrideProvider(REDIS_URL).useValue(overrides.redisUrl);
  const app = (await builder.compile()).createNestApplication();
  await app.init();
  return app;
}

describe('GET /health', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('connects only to the test database', async () => {
    app = await startApp();
    const { rows } = await app
      .get(DatabaseService)
      .pool.query<{ name: string }>('SELECT current_database() AS name');
    expect(rows[0].name).toBe('sarthi_test');
  });

  it('returns 200 when PostgreSQL and Redis are up', async () => {
    app = await startApp();
    const res = await request(app.getHttpServer() as App)
      .get('/health')
      .expect(200);
    expect(res.body).toEqual({ status: 'ok', checks: { database: 'up', redis: 'up' } });
  });

  it('returns 503 and names Redis when Redis is down', async () => {
    app = await startApp({ redisUrl: CLOSED_REDIS_URL });
    const res = await request(app.getHttpServer() as App)
      .get('/health')
      .expect(503);
    expect(res.body).toEqual({ status: 'error', checks: { database: 'up', redis: 'down' } });
  });

  it('returns 503 and names the database when PostgreSQL is down', async () => {
    app = await startApp({ databaseUrl: CLOSED_DATABASE_URL });
    const res = await request(app.getHttpServer() as App)
      .get('/health')
      .expect(503);
    expect(res.body).toEqual({ status: 'error', checks: { database: 'down', redis: 'up' } });
  });
});
