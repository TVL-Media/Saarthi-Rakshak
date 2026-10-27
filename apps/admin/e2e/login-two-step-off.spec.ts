import { expect, test } from '@playwright/test';
import {
  createFirstSuperAdminForTest,
  resetForBrowserTests,
} from '../../../server/test/browser-test-support';

// Every test starts with an empty test database.
test.beforeEach(async () => {
  await resetForBrowserTests();
});

// Server started with ADMIN_TWO_STEP=off (the local development default). Test database only.

test('2-step off: temporary password → new password → Dashboard, no 2-step screens', async ({
  page,
}) => {
  const email = 'first.admin@example.test';
  const temporaryPassword = await createFirstSuperAdminForTest('Test Super Admin', email);

  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(temporaryPassword);
  await page.getByRole('button', { name: 'Log in' }).click();

  await expect(page).toHaveURL(/\/change-password$/);
  await expect(page.getByText('1 · New password')).toBeVisible();
  await expect(page.getByText('2 · 2-step setup')).toHaveCount(0);
  await page.getByLabel('New password').fill('river-mango-lantern-42');
  await page.getByLabel('Type it again').fill('river-mango-lantern-42');
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  // Normal login: password only.
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('river-mango-lantern-42');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  // The 2-step pages are not reachable.
  await page.goto('/two-step/setup');
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
});
