import { expect, test, type Page } from '@playwright/test';
import {
  adminForTest,
  createAdminForTest,
  insertDefaultSettingsForTest,
  resetForBrowserTests,
} from '../../../server/test/browser-test-support';

// Audit Log screen. Runs on the 2-step-off server (login is tested elsewhere). Test database only.
// The browser pretends to be in New York: times must still show in India time.
test.use({ timezoneId: 'America/New_York' });

test.beforeEach(async () => {
  await resetForBrowserTests();
  await insertDefaultSettingsForTest();
});

async function logIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
}

test('real entries in plain words, India time, filters and the Details drawer', async ({
  page,
}) => {
  const password = await createAdminForTest('super_admin', 'Anjali Gupta', 'sa@example.test');

  // A failed login with an unknown email (the typed text is never stored).
  await page.goto('/login');
  await page.getByLabel('Email').fill('typed-by-mistake@example.test');
  await page.getByLabel('Password', { exact: true }).fill('whatever');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('alert')).toBeVisible();

  await logIn(page, 'sa@example.test', password);

  // A settings change with a reason.
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByLabel('Check-in: stopped too long').fill('4');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Reason for the change')
    .fill('Pilot users found 3 minutes too short');
  await page.getByRole('dialog').getByRole('button', { name: 'Save change' }).click();
  await expect(page.getByText('No unsaved changes')).toBeVisible();

  await page.getByRole('menuitem', { name: 'Audit Log' }).click();
  const change = page.getByRole('row', {
    name: /Settings · Check-in: stopped too long \(3 → 4 min\)/,
  });
  await expect(change).toBeVisible();
  await expect(change.getByText('Changed', { exact: true })).toBeVisible();
  await expect(change.getByText('Anjali Gupta')).toBeVisible();

  const unknown = page.getByRole('row', { name: /Login failed · unknown email/ });
  await expect(unknown.getByText('Unknown email', { exact: true })).toBeVisible();
  await expect(unknown.getByText('Login', { exact: true })).toBeVisible();
  await expect(unknown.getByText('Failed', { exact: true })).toBeVisible();
  await expect(page.getByText('typed-by-mistake')).toHaveCount(0);

  // India time, although the browser is in New York.
  const savedAt = (await adminForTest('sa@example.test'))!.last_login_at!;
  const indiaDay = savedAt.toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
  });
  const loginRow = page.getByRole('row', { name: /Logged in · password only/ });
  await expect(loginRow).toContainText(indiaDay);
  const indiaHour = savedAt.toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
  });
  await expect(loginRow).toContainText(indiaHour);

  // Changes only: logins disappear.
  await page.getByLabel('Kind').click();
  await page.locator('.ant-select-item-option[title="Changes only"]').click();
  await expect(change).toBeVisible();
  await expect(page.getByRole('row', { name: /Login failed/ })).toHaveCount(0);

  // Details: before → after and the reason.
  await change.getByRole('button', { name: 'Details' }).click();
  const drawer = page.getByRole('dialog', { name: 'Details' });
  await expect(drawer.getByRole('row', { name: /Before\s*3/ })).toBeVisible();
  await expect(drawer.getByRole('row', { name: /After\s*4/ })).toBeVisible();
  await expect(drawer.getByText('Pilot users found 3 minutes too short')).toBeVisible();
});

test('the Admin filter includes removed admins', async ({ page }) => {
  const password = await createAdminForTest('super_admin', 'Anjali Gupta', 'sa@example.test');
  const gonePassword = await createAdminForTest('support_admin', 'Meena Rao', 'meena@example.test');
  await logIn(page, 'meena@example.test', gonePassword);
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await logIn(page, 'sa@example.test', password);
  await page.getByRole('menuitem', { name: 'Admin Team' }).click();
  await page
    .getByRole('row', { name: /Meena Rao/ })
    .getByRole('button', { name: 'Remove' })
    .click();
  await page.getByRole('dialog').getByLabel('Reason').fill('Left the company last week');
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('row', { name: /Meena Rao/ }).getByText('Removed')).toBeVisible();

  await page.getByRole('menuitem', { name: 'Audit Log' }).click();
  await page.getByLabel('Admin').click();
  await page.locator('.ant-select-item-option[title="Meena Rao (removed)"]').click();
  await expect(page.getByRole('row', { name: /Logged out/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Anjali Gupta/ })).toHaveCount(0);
});
