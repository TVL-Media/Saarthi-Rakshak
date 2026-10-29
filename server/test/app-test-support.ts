import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import type { Kysely } from 'kysely';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApp } from '../src/app-setup';
import { AppModule } from '../src/app.module';
import { FakePhoneTokenVerifier } from '../src/app/auth/phone-token-verifier';
import { activeConnections, validateEnv } from '../src/config/env.schema';
import type { Database } from '../src/database/types';
import { openTestDatabase, resetTestDatabase } from './test-database';

/** Shared set-up for the user app (/app) tests: a server on the test database and Redis slot. */
export interface AppTestContext {
  app: INestApplication;
  db: Kysely<Database>;
  redis: Redis;
}

export async function startAppTest(): Promise<AppTestContext> {
  const db = await openTestDatabase();
  const env = validateEnv(process.env);
  const redis = new Redis(activeConnections(env).redisUrl);
  const app = (
    await Test.createTestingModule({ imports: [AppModule] }).compile()
  ).createNestApplication();
  configureApp(app, env);
  await app.init();
  return { app, db, redis };
}

export async function resetAppTest(ctx: AppTestContext): Promise<void> {
  await resetTestDatabase(ctx.db);
  await ctx.redis.flushdb(); // the test slot only
}

export async function stopAppTest(ctx: AppTestContext | undefined): Promise<void> {
  await ctx?.app.close();
  ctx?.redis.disconnect();
  await ctx?.db.destroy();
}

export const http = (ctx: AppTestContext) => request(ctx.app.getHttpServer() as App);

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Logs in as a new or existing user and accepts the terms. Returns the token and user id. */
export async function appUser(
  ctx: AppTestContext,
  phone = '+919812344521',
): Promise<{ token: string; userId: string }> {
  const res = await http(ctx)
    .post('/app/auth/login')
    .send({ firebaseIdToken: FakePhoneTokenVerifier.token(phone) })
    .expect(200);
  const { token, user } = res.body as { token: string; user: { id: string } };
  await http(ctx)
    .post('/app/me/consent')
    .set(bearer(token))
    .send({ version: '2026-10' })
    .expect(200);
  return { token, userId: user.id };
}
