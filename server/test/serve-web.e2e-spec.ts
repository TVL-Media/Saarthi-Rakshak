import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApp } from '../src/app-setup';
import { AppModule } from '../src/app.module';
import { validateEnv } from '../src/config/env.schema';
import { serveWeb } from '../src/web/serve-web';

// SERVE_WEB=on: one address serves the API, the admin panel and the guardian page.
let app: INestApplication;
let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'serve-web-'));
  const admin = join(root, 'admin');
  const guardian = join(root, 'guardian');
  mkdirSync(join(admin, 'assets'), { recursive: true });
  mkdirSync(join(guardian, 'assets'), { recursive: true });
  writeFileSync(join(admin, 'index.html'), '<title>admin</title>');
  writeFileSync(join(admin, 'assets', 'app-abc123.js'), 'console.log("admin")');
  writeFileSync(join(guardian, 'index.html'), '<title>guardian</title>');
  writeFileSync(join(guardian, 'assets', 'page-def456.js'), 'console.log("guardian")');
  writeFileSync(join(root, 'secret.txt'), 'outside');

  const env = validateEnv(process.env);
  app = (
    await Test.createTestingModule({ imports: [AppModule] }).compile()
  ).createNestApplication();
  configureApp(app, env);
  serveWeb(app, { admin, guardian });
  await app.init();
});

afterAll(async () => {
  await app?.close();
  rmSync(root, { recursive: true, force: true });
});

const get = (path: string) => request(app.getHttpServer() as App).get(path);

it('serves the admin panel for its pages, and its built files', async () => {
  for (const path of ['/', '/login', '/users', '/users/6f1c2a3b', '/live']) {
    const res = await get(path).expect(200);
    expect(res.text).toBe('<title>admin</title>');
    expect(res.headers['cache-control']).toBe('no-cache');
  }
  const js = await get('/assets/app-abc123.js').expect(200);
  expect(js.text).toContain('admin');
  expect(js.headers['cache-control']).toContain('immutable');
});

it('serves the guardian page for SMS links and its files under /gw/', async () => {
  for (const path of ['/i/AbC_12-x', '/l/AbC_12-x']) {
    expect((await get(path).expect(200)).text).toBe('<title>guardian</title>');
  }
  expect((await get('/gw/assets/page-def456.js').expect(200)).text).toContain('guardian');
});

it('leaves every server route to the server', async () => {
  expect((await get('/health').expect(200)).body).toHaveProperty('status');
  await get('/v1/me').expect(401);
  await get('/admin/auth/me').expect((r) => expect(r.text).not.toContain('<title>'));
  await get('/g/l/unknown-code').expect(410);
});

it('never serves files outside the built folders', async () => {
  for (const path of [
    '/../secret.txt',
    '/gw/../secret.txt',
    '/%2e%2e/secret.txt',
    '/gw/%2e%2e/%2e%2e/secret.txt',
  ]) {
    const res = await get(path);
    expect(res.text).not.toContain('outside');
  }
  expect((await get('/gw/missing.js')).status).toBe(404);
});
