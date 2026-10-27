import { expect, test, type Page } from '@playwright/test';
import {
  createAdminForTest,
  createUserForTest,
  resetForBrowserTests,
  userStatusForTest,
} from '../../../server/test/browser-test-support';

// Users screen. Temporary users exist only in the test database (wiped after the run).
// Runs on the 2-step-off server (login is tested elsewhere).

test.beforeEach(async () => {
  await resetForBrowserTests();
});

async function openUsers(page: Page, role: 'super_admin' | 'support_admin' = 'super_admin') {
  const password = await createAdminForTest(role, 'Test Admin', 'admin@example.test');
  await page.goto('/login');
  await page.getByLabel('Email').fill('admin@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Users' }).click();
  await expect(page.getByRole('heading', { name: 'Users', level: 1 })).toBeVisible();
}

test('with no users: the design empty state', async ({ page }) => {
  await openUsers(page);
  await expect(page.getByText('No users yet')).toBeVisible();
  await expect(page.getByText('Users appear here after they sign up in the app.')).toBeVisible();
});

test('masked phones; search by the full number only; the number stays out of the address', async ({
  page,
}) => {
  await createUserForTest('+919812344521', { name: 'Priya', complete: true });
  await createUserForTest('+919898989898', { name: 'Rahul' });
  await openUsers(page);

  await expect(page.getByRole('row', { name: /Priya/ }).getByText('+91 98•• ••4521')).toBeVisible();
  await expect(page.getByText('9812344521')).toHaveCount(0);

  const box = page.getByLabel('Search by phone number');
  await box.fill('4521');
  await box.press('Enter');
  await expect(page.getByText('Enter the full 10-digit mobile number')).toBeVisible();

  await box.fill('98123 44521');
  await box.press('Enter');
  await expect(page.getByRole('row', { name: /Priya/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Rahul/ })).toHaveCount(0);
  expect(page.url()).not.toContain('98123');

  await box.fill('9000000000');
  await box.press('Enter');
  await expect(page.getByText('No user matches')).toBeVisible();
});

test('profile: setup, device, masked guardian; block and unblock need a reason', async ({
  page,
}) => {
  const id = await createUserForTest('+919812344521', { name: 'Priya', complete: false });
  await openUsers(page, 'support_admin');
  await page.getByRole('row', { name: /Priya/ }).click();

  await expect(page.getByRole('heading', { name: 'Priya', level: 1 })).toBeVisible();
  await expect(page.getByText('+91 98•• ••4521')).toBeVisible();
  await expect(page.getByRole('row', { name: /Maa/ }).getByText('+91 98•• ••0001')).toBeVisible();
  await expect(page.getByText('Redmi Note 12')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send setup reminder' })).toBeDisabled();
  // Support Admins never see "Delete data".
  await expect(page.getByRole('button', { name: 'Delete data' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Block' }).click();
  const dialog = page.getByRole('dialog', { name: 'Block this user?' });
  await expect(dialog.getByText(/SOS always works/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Block' })).toBeDisabled();
  await dialog.getByLabel('Reason').fill('User asked us on a support call');
  await dialog.getByRole('button', { name: 'Block' }).click();
  await expect(page.getByText(/This user is blocked/)).toBeVisible();
  expect(await userStatusForTest(id)).toBe('blocked');

  await page.getByRole('button', { name: 'Unblock' }).click();
  const undo = page.getByRole('dialog', { name: 'Unblock this user?' });
  await undo.getByLabel('Reason').fill('Checked with the user again');
  await undo.getByRole('button', { name: 'Unblock' }).click();
  await expect(page.getByText(/This user is blocked/)).toHaveCount(0);
  expect(await userStatusForTest(id)).toBe('active');
});

test('Delete data: says what is deleted and kept, needs a reason, refused while a journey runs', async ({
  page,
}) => {
  const busy = await createUserForTest('+919811111111', { name: 'Busy', runningJourney: true });
  const done = await createUserForTest('+919822222222', { name: 'Done' });
  await openUsers(page);

  await page.goto(`/users/${busy}`);
  await page.getByRole('button', { name: 'Delete data' }).click();
  const dialog = page.getByRole('dialog', { name: "Delete this user's data?" });
  await expect(
    dialog.getByText('Profile, guardians, journeys, locations, recordings.'),
  ).toBeVisible();
  await expect(
    dialog.getByText('SOS events and alerts, with no link to the person.'),
  ).toBeVisible();
  await dialog.getByLabel('Reason').fill('User asked to delete their account');
  await dialog.getByRole('button', { name: 'Delete data' }).click();
  await expect(dialog.getByText(/SOS or journey running/)).toBeVisible();
  expect(await userStatusForTest(busy)).toBe('active');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await page.goto(`/users/${done}`);
  await page.getByRole('button', { name: 'Delete data' }).click();
  const second = page.getByRole('dialog', { name: "Delete this user's data?" });
  await second.getByLabel('Reason').fill('User asked to delete their account');
  await second.getByRole('button', { name: 'Delete data' }).click();
  await expect(page).toHaveURL(/\/users$/);
  await expect(page.getByRole('row', { name: /Done/ })).toHaveCount(0);
  expect(await userStatusForTest(done)).toBeUndefined();
});
