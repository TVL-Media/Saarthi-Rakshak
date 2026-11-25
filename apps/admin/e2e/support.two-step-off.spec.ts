import { expect, test, type Page } from '@playwright/test';
import {
  createAdminForTest,
  createSupportTicketForTest,
  resetForBrowserTests,
} from '../../../server/test/browser-test-support';

// Support Tickets (screen 6). Temporary records exist only in the test database (wiped after the
// run). Runs on the 2-step-off server (login is tested elsewhere).

test.beforeEach(async () => {
  await resetForBrowserTests();
});

async function openSupport(page: Page) {
  const password = await createAdminForTest('support_admin', 'Ravi', 'support_admin@example.test');
  await page.goto('/login');
  await page.getByLabel('Email').fill('support_admin@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Support Tickets' }).click();
  await expect(page.getByRole('heading', { name: 'Support Tickets', level: 1 })).toBeVisible();
}

test('with nothing yet: the empty state, no made-up tickets', async ({ page }) => {
  await openSupport(page);
  await expect(page.getByText('No tickets yet')).toBeVisible();
  await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(0);
});

test('a ticket from the app shows with a masked phone; a Support Admin takes it and resolves it', async ({
  page,
}) => {
  await createSupportTicketForTest();
  await openSupport(page);
  const row = page.locator('.ant-table-tbody tr.ant-table-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('OTP not received');
  await expect(row).toContainText('+91 98•• ••4521');
  await expect(row).toContainText('New');
  await expect(page.getByText('9812344521')).toHaveCount(0);

  await row.click();
  const drawer = page.getByRole('dialog', { name: 'Support ticket' });
  await expect(drawer.getByText('The OTP never arrives on my phone.')).toBeVisible();
  await expect(drawer.getByText('CPH2381 · app 1.1.5 (13)')).toBeVisible();

  await page.getByRole('button', { name: 'Assign to me' }).click();
  await expect(page.getByRole('button', { name: 'Unassign' })).toBeVisible();
  await expect(drawer.getByText('In progress')).toBeVisible();

  await page.getByRole('button', { name: 'Mark resolved' }).click();
  await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible();
  await expect(drawer.getByText('Resolved')).toBeVisible();
});
