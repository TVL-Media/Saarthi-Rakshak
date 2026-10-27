import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { StorageService } from '../src/storage/storage.module';

describe('File storage (local SeaweedFS, test bucket)', () => {
  let app: INestApplication;
  let storage: StorageService;
  const keys: string[] = [];

  function newKey(): string {
    const key = `test/${randomUUID()}.jpg`;
    keys.push(key);
    return key;
  }

  beforeAll(async () => {
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    await app.init();
    storage = app.get(StorageService);
  });

  afterAll(async () => {
    // Leave nothing behind in the test bucket.
    await Promise.all(keys.map((key) => storage.delete(key)));
    await app.close();
  });

  it('uses only the test bucket', () => {
    expect(storage.bucket).toBe('sarthi-test');
  });

  it('accepts an upload through an upload link, then finds and deletes the file', async () => {
    const key = newKey();
    const body = Buffer.from('fake jpeg bytes for the test');
    const url = await storage.uploadUrl(key, 'image/jpeg', body.length);

    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(body.length) },
      body,
    });
    expect(res.status).toBe(200);

    expect(await storage.info(key)).toEqual({ sizeBytes: body.length, contentType: 'image/jpeg' });

    await storage.delete(key);
    expect(await storage.info(key)).toBeNull();
  });

  it('refuses an upload with a different size than the link was made for', async () => {
    const key = newKey();
    const url = await storage.uploadUrl(key, 'image/jpeg', 10);
    const body = Buffer.alloc(20);

    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(body.length) },
      body,
    });
    expect(res.status).toBe(403);
    expect(await storage.info(key)).toBeNull();
  });

  it('refuses an upload with a different type than the link was made for', async () => {
    const key = newKey();
    const body = Buffer.alloc(10);
    const url = await storage.uploadUrl(key, 'image/jpeg', body.length);

    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/html', 'Content-Length': String(body.length) },
      body,
    });
    expect(res.status).toBe(403);
    expect(await storage.info(key)).toBeNull();
  });

  it('returns null for a file that does not exist, and deleting it is not an error', async () => {
    const key = newKey();
    expect(await storage.info(key)).toBeNull();
    await expect(storage.delete(key)).resolves.toBeUndefined();
  });
});
