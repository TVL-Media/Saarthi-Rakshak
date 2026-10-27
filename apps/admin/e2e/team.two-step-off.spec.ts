import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  adminForTest,
  auditLogTextForTest,
  createAdminForTest,
  resetForBrowserTests,
} from '../../../server/test/browser-test-support';

// Admin Team screen. Runs on the 2-step-off server (login is tested elsewhere). Test database only.

test.beforeEach(async () => {
  await resetForBrowserTests();
});

async function logIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

async function openTeam(page: Page) {
  const password = await createAdminForTest('super_admin', 'Anjali Gupta', 'sa@example.test');
  await logIn(page, 'sa@example.test', password);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Admin Team' }).click();
  await expect(page.getByRole('cell', { name: /Anjali Gupta/ })).toBeVisible();
}

async function addAdmin(page: Page, name: string, email: string, role?: 'Super Admin') {
  await page.getByRole('button', { name: 'Add admin' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add admin' });
  await dialog.getByLabel('Full name').fill(name);
  await dialog.getByLabel('Work email').fill(email);
  if (role) {
    await dialog.getByLabel('Role').click();
    await page.locator(`.ant-select-item-option[title="${role}"]`).click();
  }
  await dialog.getByRole('button', { name: 'Add admin' }).click();
}

/** The temporary password from the one-time box, then close it. */
async function takePassword(page: Page): Promise<string> {
  const box = page.getByTestId('temporary-password');
  const password = (await box.textContent())!.trim();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(box).toBeHidden();
  return password;
}

async function newPersonLogsIn(browser: Browser, email: string, password: string) {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const page = await context.newPage();
  await logIn(page, email, password);
  await expect(page).toHaveURL(/\/change-password$/);
  await context.close();
}

test('own row: "You", Remove disabled, and no 2-step column while 2-step is off', async ({
  page,
}) => {
  await openTeam(page);
  const own = page.getByRole('row', { name: /Anjali Gupta/ });
  await expect(own.getByText('You')).toBeVisible();
  await expect(own.getByRole('button', { name: 'Remove' })).toBeDisabled();
  await expect(own.getByRole('button', { name: 'Reset password' })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: '2-step' })).toHaveCount(0);
});

test('add a Support Admin: the password is shown once with the safety line, and works', async ({
  page,
  browser,
}) => {
  await openTeam(page);
  await addAdmin(page, 'Ravi Kumar', 'ravi@example.test');

  const dialog = page.getByRole('dialog', { name: 'Temporary password for Ravi Kumar' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(
      "Give this password to the person directly (in person or on a phone call). Don't send it by email or WhatsApp.",
    ),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Copy' })).toBeVisible();
  const password = await takePassword(page);

  await expect(
    page.getByRole('row', { name: /Ravi Kumar/ }).getByText('Support Admin'),
  ).toBeVisible();
  expect(await auditLogTextForTest()).not.toContain(password);
  await newPersonLogsIn(browser, 'ravi@example.test', password);
});

test('adding a Super Admin asks for an extra confirmation', async ({ page }) => {
  await openTeam(page);
  await addAdmin(page, 'Priya Shah', 'priya@example.test', 'Super Admin');

  const confirm = page.getByRole('dialog', { name: 'Add as Super Admin?' });
  await expect(
    confirm.getByText(
      'Super Admins can change safety rules and manage admins. Add as Super Admin?',
    ),
  ).toBeVisible();
  expect(await adminForTest('priya@example.test')).toBeUndefined();
  await confirm.getByRole('button', { name: 'Add as Super Admin' }).click();

  await takePassword(page);
  expect((await adminForTest('priya@example.test'))?.role).toBe('super_admin');
  // Super Admin rows have no "Reset password" (Super Admins use --reissue).
  await expect(
    page.getByRole('row', { name: /Priya Shah/ }).getByRole('button', { name: 'Reset password' }),
  ).toHaveCount(0);
});

test('reset a Support Admin’s password, remove them with a reason, then add them back', async ({
  page,
  browser,
}) => {
  await openTeam(page);
  await addAdmin(page, 'Ravi Kumar', 'ravi@example.test');
  const first = await takePassword(page);
  const row = page.getByRole('row', { name: /Ravi Kumar/ });

  await row.getByRole('button', { name: 'Reset password' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset password' }).click();
  const second = await takePassword(page);
  expect(second).not.toBe(first);
  await newPersonLogsIn(browser, 'ravi@example.test', second);

  await row.getByRole('button', { name: 'Remove' }).click();
  const remove = page.getByRole('dialog', { name: 'Remove Ravi Kumar?' });
  await expect(remove.getByRole('button', { name: 'Remove' })).toBeDisabled();
  await remove.getByLabel('Reason').fill('Left the company last week');
  await remove.getByRole('button', { name: 'Remove' }).click();
  await expect(remove).toBeHidden();

  // Still listed, at the bottom, marked "Removed", with no actions.
  const removedRow = page.getByRole('row', { name: /Ravi Kumar/ });
  await expect(removedRow.getByText('Removed')).toBeVisible();
  await expect(removedRow.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('row').last()).toContainText('Ravi Kumar');
  expect((await adminForTest('ravi@example.test'))?.status).toBe('disabled');

  // Adding them again brings the same account back, with a new temporary password.
  await addAdmin(page, 'Ravi Kumar', 'ravi@example.test');
  const third = await takePassword(page);
  const restoredRow = page.getByRole('row', { name: /Ravi Kumar/ });
  await expect(restoredRow).toHaveCount(1);
  await expect(restoredRow.getByText('Removed')).toHaveCount(0);
  await expect(restoredRow.getByRole('button', { name: 'Reset password' })).toBeVisible();
  expect((await adminForTest('ravi@example.test'))?.status).toBe('active');
  await newPersonLogsIn(browser, 'ravi@example.test', third);
});
