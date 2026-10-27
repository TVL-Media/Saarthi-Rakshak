import { expect, test, type Page } from '@playwright/test';
import {
  createAdminForTest,
  createHistoryForTest,
  resetForBrowserTests,
} from '../../../server/test/browser-test-support';

// SOS & Journey History. Temporary records exist only in the test database (wiped after the run).
// Runs on the 2-step-off server (login is tested elsewhere).

test.beforeEach(async () => {
  await resetForBrowserTests();
});

async function openHistory(page: Page) {
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
  await page.getByRole('menuitem', { name: 'SOS & Journey History' }).click();
  await expect(
    page.getByRole('heading', { name: 'SOS & Journey History', level: 1 }),
  ).toBeVisible();
}

test('with nothing yet: the design empty state', async ({ page }) => {
  await openHistory(page);
  await expect(page.getByText('No SOS or journeys yet')).toBeVisible();
});

test('rows: SOS names the user (masked), journeys never do, TEST tag, deleted user', async ({
  page,
}) => {
  await createHistoryForTest();
  await openHistory(page);

  const sosRows = page.getByRole('row', { name: /Priya/ });
  await expect(sosRows.first()).toContainText('+91 98•• ••4521');
  await expect(page.getByText('9812344521')).toHaveCount(0);
  await expect(page.getByRole('row', { name: /A user's journey/ })).toHaveCount(2);
  await expect(
    page.getByRole('row', { name: /A user's journey/ }).filter({ hasText: 'Priya' }),
  ).toHaveCount(0);
  await expect(page.getByRole('row', { name: /TEST/ })).toHaveCount(1);
  await expect(page.getByRole('row', { name: /Deleted user/ })).toContainText(
    'Cancelled in countdown',
  );
  // Nothing to edit, cancel or delete.
  await expect(page.getByRole('button', { name: /edit|cancel|delete/i })).toHaveCount(0);

  // Filters.
  await page.getByLabel('Real or test').click();
  await page.locator('.ant-select-item-option[title="Test only"]').click();
  await expect(page.getByRole('row', { name: /TEST/ })).toHaveCount(1);
  await expect(page.getByRole('row', { name: /A user's journey/ })).toHaveCount(0);
});

test('timeline: guardians numbered with relation and masked phone, gaps, no map', async ({
  page,
}) => {
  await createHistoryForTest();
  await openHistory(page);
  await page.getByRole('row', { name: /Priya/ }).filter({ hasText: 'SOS button' }).click();

  const drawer = page.getByRole('dialog', { name: 'Timeline' });
  await expect(drawer.getByText('SOS started (SOS button)')).toBeVisible();
  await expect(drawer.getByText('SMS sent to Guardian 1 (brother) +91 98•• ••0001')).toBeVisible();
  await expect(
    drawer.getByText('Guardian 1 (brother) +91 98•• ••0001 is responding'),
  ).toBeVisible();
  await expect(drawer.getByText('No location for 5 min')).toBeVisible();
  await expect(drawer.getByText('Ended: user safe')).toBeVisible();
  await expect(drawer.getByText('Rohan')).toHaveCount(0);
  await expect(drawer.getByText('9800000001')).toHaveCount(0);
  await expect(drawer.locator('canvas, iframe, [class*="map"]')).toHaveCount(0);
});

test('"Turned into SOS" opens that SOS in the timeline', async ({ page }) => {
  await createHistoryForTest();
  await openHistory(page);
  await page
    .getByRole('row', { name: /Turned into SOS/ })
    .getByRole('button', { name: 'Turned into SOS' })
    .click();
  const drawer = page.getByRole('dialog', { name: 'Timeline' });
  await expect(drawer.getByText('SOS started (journey)')).toBeVisible();
});
