import { expect, test, type Page } from '@playwright/test';
import {
  createAdminForTest,
  resetForBrowserTests,
} from '../../../server/test/browser-test-support';

// Safety Services (Phase 4). Temporary records exist only in the test database (wiped after the run).
// Runs on the 2-step-off server (login is tested elsewhere).

test.beforeEach(async () => {
  await resetForBrowserTests();
});

async function openScreen(page: Page, role: 'support_admin' | 'super_admin') {
  const password = await createAdminForTest(role, 'Test Admin', `${role}@example.test`);
  await page.goto('/login');
  await page.getByLabel('Email').fill(`${role}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Safety Services' }).click();
  await expect(page.getByRole('heading', { name: 'Safety Services', level: 1 })).toBeVisible();
}

test('with nothing yet: empty states, no made-up partners, requests or guidance', async ({
  page,
}) => {
  await openScreen(page, 'super_admin');
  await expect(page.getByText('Nothing yet').first()).toBeVisible();
  await page.locator('.ant-segmented-item-label', { hasText: 'Partners' }).click();
  await expect(page.getByText('No partners')).toBeVisible();
  await page.locator('.ant-segmented-item-label', { hasText: 'Requests' }).click();
  await expect(page.getByText('No requests')).toBeVisible();
  await page.locator('.ant-segmented-item-label', { hasText: 'Guidance' }).click();
  await expect(page.getByText('No guidance yet')).toBeVisible();
  await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(0);
});

test('a Super Admin adds a safe point, verifies it, approves it with an expiry, and can remove the badge', async ({
  page,
}) => {
  await openScreen(page, 'super_admin');
  await page.locator('.ant-segmented-item-label', { hasText: 'Partners' }).click();
  await page.getByRole('button', { name: 'Add partner' }).click();
  const dialog = page.locator('.ant-modal');
  await dialog.getByLabel('Name').fill('Metro Help Desk');
  await dialog.getByLabel('Category').click();
  await page.locator('.ant-select-item-option', { hasText: 'help desk' }).click();
  await dialog.getByLabel('Latitude (required)').fill('28.5707');
  await dialog.getByLabel('Longitude (required)').fill('77.3219');
  await dialog.getByRole('button', { name: 'Save' }).click();

  const drawer = page.locator('.ant-drawer');
  await expect(drawer.getByText('Metro Help Desk')).toBeVisible();
  await expect(drawer.getByText('submitted')).toBeVisible();
  await drawer.getByRole('button', { name: 'Mark verified' }).click();
  await expect(drawer.getByText('verified', { exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: 'Approve' }).click();
  await page.locator('.ant-modal').getByRole('button', { name: 'Approve' }).click();
  await expect(drawer.getByText(/badge until/)).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Remove badge now' })).toBeVisible();
});

test('a Support Admin can verify but not approve', async ({ page }) => {
  await openScreen(page, 'support_admin');
  await page.locator('.ant-segmented-item-label', { hasText: 'Partners' }).click();
  await page.getByRole('button', { name: 'Add partner' }).click();
  const dialog = page.locator('.ant-modal');
  await dialog.getByLabel('Name').fill('Hospital Desk');
  await dialog.getByLabel('Category').click();
  await page.locator('.ant-select-item-option', { hasText: 'hospital' }).click();
  await dialog.getByLabel('Latitude (required)').fill('28.57');
  await dialog.getByLabel('Longitude (required)').fill('77.32');
  await dialog.getByRole('button', { name: 'Save' }).click();
  const drawer = page.locator('.ant-drawer');
  await drawer.getByRole('button', { name: 'Mark verified' }).click();
  await expect(drawer.getByText('verified', { exact: true })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Approve' })).toHaveCount(0);
});

test('guidance is a draft until a Super Admin approves it with review dates', async ({ page }) => {
  await openScreen(page, 'super_admin');
  await page.locator('.ant-segmented-item-label', { hasText: 'Guidance' }).click();
  await page.getByRole('button', { name: 'Add guidance' }).click();
  const dialog = page.locator('.ant-modal');
  await dialog.getByLabel('Title').fill('If you are being followed');
  await dialog.getByLabel('Steps (one per line, up to 12)').fill('Go to a busy place\nCall 112');
  await dialog.getByRole('button', { name: 'Save' }).click();
  const row = page.locator('.ant-table-tbody tr.ant-table-row');
  await expect(row).toContainText('If you are being followed');
  await expect(row).toContainText('draft');
  await row.getByRole('button', { name: 'Approve' }).click();
  await page.locator('.ant-modal').getByRole('button', { name: 'Approve' }).click();
  await expect(row).toContainText('approved');
});
