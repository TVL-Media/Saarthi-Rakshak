import { resetForBrowserTests } from '../../../server/test/browser-test-support';

export default async function globalSetup(): Promise<void> {
  process.env.NODE_ENV = 'test';
  await resetForBrowserTests();
}
