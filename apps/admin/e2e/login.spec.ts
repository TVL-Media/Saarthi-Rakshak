import { expect, test, type Page } from '@playwright/test';
import {
  authenticatorCode,
  createFirstSuperAdminForTest,
  createSupportAdminForTest,
  endSessionsForTest,
  resetForBrowserTests,
} from '../../../server/test/browser-test-support';

// Every test starts with an empty test database.
test.beforeEach(async () => {
  await resetForBrowserTests();
});

// Test database only (see playwright.config.ts). Records are wiped after the run.

async function logIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

async function typeCode(page: Page, code: string) {
  // The six code boxes (Ant Design Input.OTP): fill each one.
  for (const [i, digit] of [...code].entries()) {
    await page.getByLabel(`OTP Input ${i + 1}`).fill(digit);
  }
}

test('first login: temporary password → new password → 2-step setup → backup codes → Dashboard', async ({
  page,
  context,
}) => {
  const email = 'first.admin@example.test';
  const temporaryPassword = await createFirstSuperAdminForTest('Test Super Admin', email);

  // Wrong details: one message, never says which field was wrong.
  await logIn(page, email, 'not-the-password');
  await expect(page.getByRole('alert')).toHaveText(
    'Email or password is wrong. After 5 wrong tries the account is locked for 15 minutes.',
  );

  await logIn(page, email, temporaryPassword);
  await expect(page).toHaveURL(/\/change-password$/);

  // The session cookie is HttpOnly, Secure and SameSite=Strict.
  const cookie = (await context.cookies()).find((c) => c.name === '__Host-sr_admin');
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });

  const firstRule = page.getByText('At least 12 characters');
  await expect(firstRule).not.toHaveClass(/met/);
  await page.getByLabel('New password').fill('river-mango-lantern-42');
  await expect(firstRule).toHaveClass(/met/);
  await page.getByLabel('Type it again').fill('river-mango-lantern-42');
  await page.getByRole('button', { name: 'Save password' }).click();

  await expect(page).toHaveURL(/\/two-step\/setup$/);
  await expect(page.getByRole('heading', { name: 'Turn on 2-step login' })).toBeVisible();
  const key = (await page.getByTestId('setup-key').textContent())!.trim();

  await typeCode(page, '000000');
  await page.getByRole('button', { name: 'Turn on 2-step login' }).click();
  await expect(
    page.getByText("That code didn't work. Check the time on your phone and try the newest code."),
  ).toBeVisible();

  await typeCode(page, authenticatorCode(key));
  await page.getByRole('button', { name: 'Turn on 2-step login' }).click();

  await expect(page.getByRole('heading', { name: 'Save your backup codes' })).toBeVisible();
  await expect(page.getByTestId('backup-codes').locator('span')).toHaveCount(10);
  const continueButton = page.getByRole('button', { name: 'Continue to the panel' });
  await expect(continueButton).toBeDisabled();
  await page
    .getByLabel('I have saved these codes somewhere safe, away from this computer.')
    .check();
  await continueButton.click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await expect(page.getByText('Test Super Admin')).toBeVisible();
  await expect(page.getByText('SUPER ADMIN ONLY')).toBeVisible();

  // Log out, then a normal login: password → 2-step code → Dashboard.
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await logIn(page, email, 'river-mango-lantern-42');
  await expect(page).toHaveURL(/\/two-step$/);
  // The code from setup was already used in this 30-second step; the next one is accepted.
  await typeCode(page, authenticatorCode(key, 1));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
});

test('a Support Admin cannot see Settings, in the menu or by URL', async ({ page }) => {
  const email = 'support@example.test';
  const support = await createSupportAdminForTest('Test Support', email);

  await logIn(page, email, support.password);
  await expect(page).toHaveURL(/\/two-step$/);
  await typeCode(page, authenticatorCode(support.secret));
  await page.getByRole('button', { name: 'Verify' }).click();

  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await expect(page.getByText('Support Admin')).toBeVisible();
  await expect(page.getByText('SUPER ADMIN ONLY')).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Settings' })).toHaveCount(0);

  await page.goto('/settings');
  await expect(page.getByText('Only a Super Admin can open this page')).toBeVisible();
  await page.getByRole('button', { name: 'Go to Dashboard' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
});

test.describe('when the server ends the session', () => {
  async function logInSupport(page: Page, email: string) {
    const support = await createSupportAdminForTest('Support Person', email);
    await logIn(page, email, support.password);
    await expect(page).toHaveURL(/\/two-step$/);
    await typeCode(page, authenticatorCode(support.secret));
    await page.getByRole('button', { name: 'Verify' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  }

  test('an open page goes to /login by itself after 30 minutes idle', async ({ page }) => {
    await page.clock.install();
    await logInSupport(page, 'idle@example.test');
    await page.getByRole('menuitem', { name: 'Users' }).click();
    await expect(page.getByRole('heading', { name: 'Users', level: 1 })).toBeVisible();

    await endSessionsForTest('idle@example.test', 'idle');
    // The panel checks the session once a minute; no click or reload needed.
    await page.clock.runFor(61_000);
    await expect(page).toHaveURL(/\/login$/);
    await expect(
      page.getByText(
        'You were logged out after 30 minutes without activity. Log in again to continue.',
      ),
    ).toBeVisible();
  });

  test('a session ended elsewhere shows "Your session ended" (nothing more)', async ({ page }) => {
    await logInSupport(page, 'ended@example.test');
    await endSessionsForTest('ended@example.test', 'ended');
    await page.reload();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText('Your session ended. Log in again.')).toBeVisible();
  });
});

test('the 2-step QR code stays the same while the setup page is open', async ({ page }) => {
  await page.clock.install();
  let setupRequests = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/admin/auth/2fa/setup')) setupRequests++;
  });
  const temporaryPassword = await createFirstSuperAdminForTest(
    'Test Super Admin',
    'qr@example.test',
  );
  await logIn(page, 'qr@example.test', temporaryPassword);
  await page.getByLabel('New password').fill('river-mango-lantern-42');
  await page.getByLabel('Type it again').fill('river-mango-lantern-42');
  await page.getByRole('button', { name: 'Save password' }).click();
  const key = page.getByTestId('setup-key');
  const first = await key.textContent();

  // The panel checks the session every minute; that must not ask for a new secret.
  await page.clock.runFor(3 * 61_000);
  await expect(key).toHaveText(first!);
  expect(setupRequests).toBe(1);
});

test('with 2-step on, the Admin Team shows the 2-step column', async ({ page }) => {
  const admin = await createSupportAdminForTest(
    'Test Super Admin',
    'sa-team@example.test',
    'super_admin',
  );
  await logIn(page, 'sa-team@example.test', admin.password);
  await expect(page).toHaveURL(/\/two-step$/);
  await typeCode(page, authenticatorCode(admin.secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.getByRole('menuitem', { name: 'Admin Team' }).click();
  await expect(page.getByRole('columnheader', { name: '2-step' })).toBeVisible();
  await expect(page.getByRole('row', { name: /Test Super Admin/ }).getByText('On')).toBeVisible();
});
