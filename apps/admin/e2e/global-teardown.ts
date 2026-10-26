import { wipeAfterBrowserTests } from '../../../server/test/browser-test-support';

// No test records are left behind.
export default async function globalTeardown(): Promise<void> {
  process.env.NODE_ENV = 'test';
  await wipeAfterBrowserTests();
}
