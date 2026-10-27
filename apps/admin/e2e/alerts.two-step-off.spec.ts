import { expect, test, type Page } from '@playwright/test';
import { MAX_SMS_ATTEMPTS } from '../../../server/src/alerts/alerts.constants';
import {
  createAdminForTest,
  createAlertsForTest,
  resetForBrowserTests,
} from '../../../server/test/browser-test-support';

// Alert Log. Temporary records exist only in the test database (wiped after the run).
// Runs on the 2-step-off server (login is tested elsewhere).

test.beforeEach(async () => {
  await resetForBrowserTests();
});

async function openAlerts(page: Page) {
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
  await page.getByRole('menuitem', { name: 'Alert Log' }).click();
  await expect(page.getByRole('heading', { name: 'Alert Log', level: 1 })).toBeVisible();
}

test('with nothing yet: zeros, the empty state, SMS setup "Not set up", the OTP line', async ({
  page,
}) => {
  await openAlerts(page);
  await expect(
    page.getByText("Login OTPs are sent by Firebase and don't appear here."),
  ).toBeVisible();
  await expect(page.getByText('No alerts sent yet')).toBeVisible();
  for (const label of ['Sent today', 'Delivered', 'Failed', 'Sent by backup provider']) {
    await expect(page.locator('.sr-stat', { hasText: label }).locator('b')).toHaveText('0');
  }
  await expect(page.getByText('Not set up')).toHaveCount(4);
});

test('next steps, failures first, masked guardians; a row opens the timeline', async ({ page }) => {
  await createAlertsForTest(MAX_SMS_ATTEMPTS);
  await openAlerts(page);

  const rows = page.locator('.ant-table-tbody tr.ant-table-row');
  await expect(rows).toHaveCount(5);
  // Failures not fixed by a later try come first (newest first among them).
  await expect(rows.nth(0)).toContainText('Push');
  await expect(rows.nth(0)).toContainText('SMS was sent too');
  await expect(rows.nth(1)).toContainText('Guardian 2 +91 98•• ••0002');
  await expect(rows.nth(1).getByText('All tries failed. Check provider status.')).toHaveClass(
    /sr-err-text/,
  );
  // Then the rest, newest first.
  await expect(rows.nth(2)).toContainText('Delivered');
  await expect(rows.nth(3)).toContainText('Sent again (see newer row)');
  await expect(rows.nth(4)).toContainText('Waiting for delivery report');
  await expect(rows.nth(3)).toContainText('Guardian 1 (brother) +91 98•• ••0001');
  // Push never shows "Delivered"; nobody is named; no full numbers.
  await expect(page.getByText(/Priya|Rohan|Meera|9800000001|9812344521/)).toHaveCount(0);

  // Today's counters.
  await expect(page.locator('.sr-stat', { hasText: 'Sent today' }).locator('b')).toHaveText('2');
  await expect(page.locator('.sr-stat', { hasText: 'Failed' }).locator('b')).toHaveText('2');
  await expect(
    page.locator('.sr-stat', { hasText: 'Sent by backup provider' }).locator('b'),
  ).toHaveText('1');

  await rows.nth(1).click();
  const drawer = page.getByRole('dialog', { name: 'Timeline' });
  await expect(drawer.getByText('SOS started (SOS button)')).toBeVisible();
  await expect(drawer.getByText('SMS to Guardian 2 +91 98•• ••0002 failed')).toBeVisible();
});
