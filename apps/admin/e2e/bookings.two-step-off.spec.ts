import { expect, test, type Page } from '@playwright/test';
import {
  createAdminForTest,
  createBookingForTest,
  resetForBrowserTests,
} from '../../../server/test/browser-test-support';

// Bookings (Phase 3). Temporary records exist only in the test database (wiped after the run).
// Runs on the 2-step-off server (login is tested elsewhere).

test.beforeEach(async () => {
  await resetForBrowserTests();
});

async function openBookings(page: Page, role: 'support_admin' | 'super_admin') {
  const password = await createAdminForTest(role, 'Test Admin', `${role}@example.test`);
  await page.goto('/login');
  await page.getByLabel('Email').fill(`${role}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Bookings' }).click();
  await expect(page.getByRole('heading', { name: 'Bookings', level: 1 })).toBeVisible();
}

test('with nothing yet: the empty state, no made-up bookings', async ({ page }) => {
  await openBookings(page, 'support_admin');
  await expect(page.getByText('No bookings')).toBeVisible();
  await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(0);
});

test('a booking shows a masked phone and the place name; a Support Admin can assign but not quote', async ({
  page,
}) => {
  await createBookingForTest();
  await openBookings(page, 'support_admin');
  const row = page.locator('.ant-table-tbody tr.ant-table-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Home Guard');
  await expect(row).toContainText('+91 98•• ••4521');
  await expect(row).toContainText('Sector 18');
  await expect(page.getByText('9812344521')).toHaveCount(0);

  await row.click();
  await expect(page.getByRole('button', { name: 'Cancel booking' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Assign Rakshak' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send quote' })).toHaveCount(0);
  await expect(page.getByText('History (cannot be edited)')).toBeVisible();
});

test('a Super Admin sends a quote and the booking moves to Quoted', async ({ page }) => {
  await createBookingForTest();
  await openBookings(page, 'super_admin');
  await page.locator('.ant-table-tbody tr.ant-table-row').click();
  await page.getByRole('button', { name: 'Send quote' }).click();
  await page.getByPlaceholder('Amount in rupees').fill('499.5');
  await page.locator('.ant-modal').getByRole('button', { name: 'Send quote' }).click();
  await expect(page.getByText('₹499.5')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change quote' })).toBeVisible();
});
