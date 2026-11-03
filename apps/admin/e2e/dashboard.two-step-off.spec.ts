import { expect, test, type Page } from '@playwright/test';
import {
  auditCountForTest,
  createAdminForTest,
  createDashboardSceneForTest,
  resetForBrowserTests,
} from '../../../server/test/browser-test-support';

// Dashboard. Temporary records exist only in the test database (wiped after the run).
// Runs on the 2-step-off server (login is tested elsewhere).

test.beforeEach(async () => {
  await resetForBrowserTests();
});

async function logIn(page: Page) {
  const password = await createAdminForTest(
    'support_admin',
    'Test Support',
    'support@example.test',
  );
  await page.goto('/login');
  await page.getByLabel('Email').fill('support@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
}

const stat = (page: Page, label: string) =>
  page.locator('.sr-stat', { hasText: label }).locator('b');

test('with nothing yet: zeros, real system health, empty states', async ({ page }) => {
  await logIn(page);
  for (const label of [
    'Active SOS',
    'Active journeys',
    'SOS today',
    'New users today',
    'Failed alerts today',
  ]) {
    await expect(stat(page, label)).toHaveText('0');
  }
  await expect(page.locator('.sr-status-row', { hasText: 'Database' })).toContainText('Working');
  await expect(page.locator('.sr-status-row', { hasText: 'Live data (Redis)' })).toContainText(
    'Working',
  );
  await expect(page.locator('.sr-status-row', { hasText: 'Push notifications' })).toContainText(
    'Not set up',
  );
  await expect(page.getByText('No active SOS')).toBeVisible();
  await expect(page.getByText('Nothing needs attention')).toBeVisible();
  await expect(page.getByText('No events yet')).toBeVisible();
});

test('active SOS: map line, needs attention, recent events; no names or phone numbers', async ({
  page,
}) => {
  await createDashboardSceneForTest();
  await logIn(page);

  await expect(stat(page, 'Active SOS')).toHaveText('1');
  await expect(page.getByText('1 active SOS ·')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Live SOS' })).toHaveAttribute('href', '/live');

  const attention = page.locator('.ant-card', { hasText: 'Needs attention' });
  await expect(attention.getByRole('link').first()).toHaveText(
    'Active SOS: no guardian has responded yet',
  );
  await expect(attention.getByRole('link', { name: '1 user has unfinished setup' })).toBeVisible();

  const recent = page.locator('.ant-card', { hasText: 'Recent events' });
  await expect(recent.getByText('SOS ended: user safe')).toBeVisible();
  await expect(recent.getByText('New user signed up')).toBeVisible();
  await expect(page.getByText(/Priya|98••|9812344521/)).toHaveCount(0);

  // An SOS line opens its timeline in History.
  await recent.getByRole('link', { name: 'SOS ended: user safe' }).click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(
    page.getByRole('dialog', { name: 'Timeline' }).getByText('Ended: user safe'),
  ).toBeVisible();

  // "Unfinished setup" opens Users already filtered.
  await page.goto('/');
  await page.getByRole('link', { name: '1 user has unfinished setup' }).click();
  await expect(page).toHaveURL(/\/users$/);
  await expect(page.locator('.sr-filters').getByText('Setup unfinished')).toBeVisible();
  await expect(page.getByRole('row', { name: /Priya/ })).toBeVisible();
});

test('opening is logged once; the 30-second refreshes are not', async ({ page }) => {
  await page.clock.install();
  await logIn(page);
  await expect.poll(() => auditCountForTest('dashboard.viewed')).toBe(1);
  // Three refreshes, 31 seconds apart.
  for (let i = 0; i < 3; i++) {
    const refresh = page.waitForRequest(
      (r) => r.method() === 'GET' && r.url().endsWith('/admin/dashboard'),
    );
    await page.clock.runFor(31_000);
    await (await refresh).response();
  }
  expect(await auditCountForTest('dashboard.viewed')).toBe(1);
  expect(await auditCountForTest('GET /admin/dashboard')).toBe(0);
});
