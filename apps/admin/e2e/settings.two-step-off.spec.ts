import { expect, test, type Page } from '@playwright/test';
import {
  createAdminForTest,
  insertDefaultSettingsForTest,
  resetForBrowserTests,
  settingChangesForTest,
  settingValueForTest,
} from '../../../server/test/browser-test-support';

// Settings screen. Runs on the 2-step-off server (login is tested elsewhere). Test database only.

test.beforeEach(async () => {
  await resetForBrowserTests();
  await insertDefaultSettingsForTest();
});

async function openSettings(page: Page) {
  const password = await createAdminForTest('super_admin', 'Test Super Admin', 'sa@example.test');
  await page.goto('/login');
  await page.getByLabel('Email').fill('sa@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page.getByLabel('SOS countdown')).toHaveValue('5');
}

test('change a rule: the modal lists it, asks for a reason, and it is saved and logged', async ({
  page,
}) => {
  await openSettings(page);
  await expect(page.getByText('No unsaved changes')).toBeVisible();
  await expect(page.getByText('Cancel without PIN')).toBeVisible();
  await expect(page.getByLabel('Main provider')).toBeDisabled();

  await page.getByLabel('Check-in: stopped too long').fill('4');
  await expect(page.getByText('1 unsaved change')).toBeVisible();
  await page.getByRole('button', { name: 'Save changes' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Save 1 change?')).toBeVisible();
  await expect(
    dialog.getByText(
      'Check-in: stopped too long · 3 min → 4 min. Applies to new SOS events and journeys from now on. Ones already running keep the old rule.',
    ),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save change' })).toBeDisabled();
  await dialog.getByLabel('Reason for the change').fill('Pilot users found 3 minutes too short');
  await dialog.getByRole('button', { name: 'Save change' }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText('No unsaved changes')).toBeVisible();
  await expect(page.getByLabel('Check-in: stopped too long')).toHaveValue('4');
  expect(await settingValueForTest('checkin.stopped_minutes')).toBe(4);
  expect(await settingChangesForTest()).toEqual([
    {
      target_id: 'checkin.stopped_minutes',
      reason: 'Pilot users found 3 minutes too short',
      details: { setting: 'checkin.stopped_minutes', before: 3, after: 4 },
    },
  ]);
});

test('the special "applies" texts for audio and max guardians', async ({ page }) => {
  await openSettings(page);
  await page.getByLabel('Audio auto-delete').fill('60');
  await page.getByLabel('Max guardians').fill('3');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Save 2 changes?')).toBeVisible();
  await expect(
    dialog.getByText('Audio auto-delete · 30 days → 60 days. Applies to new recordings only.'),
  ).toBeVisible();
  await expect(
    dialog.getByText(
      "Max guardians · 5 people → 3 people. Users who already have more keep them, but can't add more.",
    ),
  ).toBeVisible();
});

test('a value outside its range shows an error and cannot be saved; Discard restores', async ({
  page,
}) => {
  await openSettings(page);
  await page.getByLabel('SOS countdown').fill('11');
  await expect(page.getByText('Must be 10 or less')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();

  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByLabel('SOS countdown')).toHaveValue('5');
  await expect(page.getByText('No unsaved changes')).toBeVisible();
  expect(await settingValueForTest('sos.countdown_seconds')).toBe(5);
});

test('a feature switch turns on and is saved; a bad value says why Save is off', async ({ page }) => {
  await openSettings(page);
  await page.getByLabel('Chhupa Rakshak', { exact: true }).click();
  await expect(page.getByText('1 unsaved change')).toBeVisible();
  await page.getByRole('button', { name: 'Save changes' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reason for the change').fill('Start the Noida pilot');
  await dialog.getByRole('button', { name: 'Save change' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('No unsaved changes')).toBeVisible();
  expect(await settingValueForTest('feature.chhupa_rakshak')).toBe(1);

  await page.getByLabel('SOS countdown').fill('99');
  await expect(page.getByText('1 value needs fixing before you can save')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await page.getByRole('button', { name: 'Show me' }).click();
  await expect(page.getByLabel('SOS countdown')).toBeFocused();
});
