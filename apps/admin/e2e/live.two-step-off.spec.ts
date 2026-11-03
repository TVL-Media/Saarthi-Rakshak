import { expect, test, type Page } from '@playwright/test';
import {
  auditCountForTest,
  createAdminForTest,
  createLiveSceneForTest,
  endSosForTest,
  resetForBrowserTests,
} from '../../../server/test/browser-test-support';

// Live SOS. Temporary records exist only in the test database (wiped after the run).
// Runs on the 2-step-off server (login is tested elsewhere).

test.beforeEach(async () => {
  await resetForBrowserTests();
});

async function openLive(page: Page) {
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
  await page.getByRole('menuitem', { name: 'Live SOS' }).click();
  await expect(page.getByRole('heading', { name: 'Live SOS', level: 1 })).toBeVisible();
}

test('nothing active: the view-only banner and the empty states', async ({ page }) => {
  await openLive(page);
  await expect(page.getByText(/View only\. Admins cannot act on an SOS/)).toBeVisible();
  await expect(
    page.getByText('It is not a 24/7 monitoring service.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('No active SOS right now')).toBeVisible();
  await expect(page.getByText('Select an SOS')).toBeVisible();
});

test('list: lost contact first, masked phone, no names; details without coordinates; logged', async ({
  page,
}) => {
  const { lost } = await createLiveSceneForTest();
  await openLive(page);

  const items = page.getByRole('listitem');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('+91 98•• ••2222');
  await expect(items.nth(0)).toContainText('Lost contact');
  await expect(items.nth(0)).toContainText('No guardian responding');
  await expect(items.nth(1)).toContainText('+91 98•• ••1111');
  await expect(page.getByRole('list').getByText(/Priya|Rahul/)).toHaveCount(0);
  await expect.poll(() => auditCountForTest('live.viewed')).toBe(1);
  expect(await auditCountForTest('live_sos.viewed')).toBe(0);

  await items.nth(1).click();
  await expect(page.getByRole('link', { name: /Priya \+91 98•• ••1111/ })).toBeVisible();
  await expect(
    page.getByText(/min ago, accurate to 15 m|Just now, accurate to 15 m/),
  ).toBeVisible();
  await expect(page.getByText('42%')).toBeVisible();
  await expect(
    page.getByRole('row', { name: /Guardian 1 \(brother\) \+91 98•• ••0001/ }),
  ).toContainText('Responding');
  await expect(page.getByText('No audio yet')).toBeVisible();
  await expect(page.getByRole('button', { name: /play|download/i })).toHaveCount(0);
  await expect(page.getByText(/77\.31|28\.56/)).toHaveCount(0);
  await expect.poll(() => auditCountForTest('live_sos.viewed')).toBe(1);

  await items.nth(0).click();
  await expect(page.getByText(/Lost contact: no location for 9 min/)).toBeVisible();
  await expect.poll(() => auditCountForTest('live_sos.viewed')).toBe(2);
  expect(lost).toBeTruthy();
});

test('when the open SOS ends, the page says so and links to History', async ({ page }) => {
  await page.clock.install();
  const { calm } = await createLiveSceneForTest();
  await openLive(page);
  await page.getByRole('listitem').nth(1).click();
  await expect(page.getByText('42%')).toBeVisible();

  await endSosForTest(calm);
  await page.clock.runFor(6_000);
  await expect(page.getByText('This SOS ended: user safe')).toBeVisible();
  await expect(page.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('link', { name: 'See it in History' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Timeline' }).getByText('Ended: user safe'),
  ).toBeVisible();
});
