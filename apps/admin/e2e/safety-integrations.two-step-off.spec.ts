import { expect, test } from '@playwright/test';
import { createAdminForTest, insertDefaultSettingsForTest, resetForBrowserTests } from '../../../server/test/browser-test-support';

// Safety Integrations screen. Test database only; nothing is pre-filled, every record is made here.

test.beforeEach(async () => {
  await resetForBrowserTests();
  await insertDefaultSettingsForTest();
});

test('empty states, then a Super Admin adds a school (key shown once), verifies it, and adds a glasses model', async ({ page }) => {
  const password = await createAdminForTest('super_admin', 'Test Super Admin', 'sa@example.test');
  await page.goto('/login');
  await page.getByLabel('Email').fill('sa@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/safety-integrations');

  await expect(page.getByText('No schools yet')).toBeVisible();
  await page.getByRole('button', { name: 'Add school' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('School code').fill('NOIDA-01');
  await dialog.getByLabel('Name').fill('Test Public School');
  await dialog.getByRole('button', { name: 'Save' }).click();

  const key = page.getByRole('dialog').filter({ hasText: 'Signing key' });
  await expect(key).toBeVisible();
  await expect(key.locator('textarea')).not.toHaveValue('');
  await key.getByRole('button', { name: 'OK' }).click();

  await expect(page.getByRole('cell', { name: 'Test Public School' })).toBeVisible();
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText('verified', { exact: true })).toBeVisible();

  await page.getByText('Smart glasses', { exact: true }).click();
  await expect(page.getByText(/No .*glasses|No models/i).first()).toBeVisible();
  await page.getByRole('button', { name: 'Add model' }).click();
  const m = page.getByRole('dialog');
  await m.getByLabel('Manufacturer').fill('TestMaker');
  await m.getByLabel('Model', { exact: true }).fill('G1');
  await m.getByLabel('Minimum firmware').fill('1.0.0');
  await m.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('cell', { name: 'TestMaker' })).toBeVisible();
});

test('a Support Admin cannot add a school', async ({ page }) => {
  const password = await createAdminForTest('support_admin', 'Test Support', 'support@example.test');
  await page.goto('/login');
  await page.getByLabel('Email').fill('support@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/safety-integrations');
  await expect(page.getByText('No schools yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add school' })).toHaveCount(0);
});
