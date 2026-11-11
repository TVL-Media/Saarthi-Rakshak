import type { InviteInfo, LiveView } from '@sarthi/shared';
import { expect, test, type Page } from '@playwright/test';

const CODE = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd';

function json(page: Page, method: string, path: string, status: number, body?: unknown) {
  return page.route(`**${path}`, (route) =>
    route.request().method() === method
      ? route.fulfill({
          status,
          contentType: 'application/json',
          body: body === undefined ? '' : JSON.stringify(body),
        })
      : route.fallback(),
  );
}

const invite: InviteInfo = {
  inviterFirstName: 'Priya',
  guardianName: 'Ravi',
  status: 'pending',
  expiresAt: '2026-11-09T10:00:00Z',
};

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const sosView = (extra: Partial<LiveView> = {}): LiveView => ({
  kind: 'sos',
  status: 'active',
  outcome: null,
  person: { firstName: 'Priya', phone: '+919812344521', bloodGroup: 'B+' },
  location: {
    sosId: 'a5f0c0de-1111-4222-8333-444455556666',
    journeyId: null,
    lat: 28.5706,
    lng: 77.3272,
    accuracyM: 8,
    batteryPct: 54,
    network: 'mobile',
    recordedAt: minutesAgo(2),
  },
  batteryPct: 54,
  lostContact: false,
  startedAt: minutesAgo(5),
  endedAt: null,
  journey: null,
  guardians: [
    { firstName: 'Ravi', status: 'opened', isYou: true },
    { firstName: 'Sita', status: 'responding', isYou: false },
  ],
  youAreResponding: false,
  trigger: 'button',
  photos: [],
  ...extra,
});

test.beforeEach(async ({ page }) => {
  // No live-update server in these tests.
  await page.route('**/g/socket.io/**', (route) => route.abort());
  await page.routeWebSocket(/\/g\/socket\.io\//, (ws) => ws.close());
});

test.describe('Invite page', () => {
  test('accept', async ({ page }) => {
    await json(page, 'GET', `/g/i/${CODE}`, 200, invite);
    await json(page, 'POST', `/g/i/${CODE}/accept`, 204);
    await page.goto(`/i/${CODE}`);
    await expect(page.getByRole('heading')).toHaveText(
      'Priya added you as a safety guardian, Ravi',
    );
    await page.getByRole('button', { name: 'Accept' }).click();
    await expect(page.getByRole('heading', { name: 'You are a safety guardian' })).toBeVisible();
    await expect(page.getByText('You’ll get Priya’s alerts by SMS')).toBeVisible();
  });

  test('decline asks first', async ({ page }) => {
    await json(page, 'GET', `/g/i/${CODE}`, 200, invite);
    await json(page, 'POST', `/g/i/${CODE}/decline`, 204);
    await page.goto(`/i/${CODE}`);
    await page.getByRole('button', { name: 'Decline' }).click();
    await expect(page.getByText('Your number will be deleted')).toBeVisible();
    await page.getByRole('button', { name: 'Yes, decline' }).click();
    await expect(page.getByRole('heading', { name: 'Invite declined' })).toBeVisible();
    await expect(page.getByText('You won’t be added again by Priya.')).toBeVisible();
  });

  test('expired link', async ({ page }) => {
    await json(page, 'GET', `/g/i/${CODE}`, 410, {
      error: 'link_expired',
      message: 'This invite link has expired.',
    });
    await page.goto(`/i/${CODE}`);
    await expect(
      page.getByRole('heading', { name: 'This invite link no longer works' }),
    ).toBeVisible();
  });

  test('already accepted', async ({ page }) => {
    await json(page, 'GET', `/g/i/${CODE}`, 200, { ...invite, status: 'accepted' });
    await page.goto(`/i/${CODE}`);
    await expect(page.getByRole('heading', { name: 'You are a safety guardian' })).toBeVisible();
  });
});

test.describe('Live page', () => {
  test('SOS by crash detection: says so and shows the photos', async ({ page }) => {
    const photo = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    await json(
      page,
      'GET',
      `/g/l/${CODE}`,
      200,
      sosView({
        trigger: 'crash',
        photos: [
          { camera: 'back', url: photo, takenAt: minutesAgo(4) },
          { camera: 'front', url: `${photo}#f`, takenAt: minutesAgo(4) },
        ],
      }),
    );
    await page.goto(`/l/${CODE}`);
    await expect(page.getByText('This SOS was started by crash detection.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Photos from Priya’s phone' })).toBeVisible();
    await expect(page.getByAltText('Back camera photo')).toBeVisible();
    await expect(page.getByAltText('Front camera photo')).toBeVisible();
  });

  test('SOS: details, calls and "I\'m responding"', async ({ page }) => {
    await json(page, 'GET', `/g/l/${CODE}`, 200, sosView());
    await json(page, 'POST', `/g/l/${CODE}/responding`, 200, sosView({ youAreResponding: true }));
    await page.goto(`/l/${CODE}`);

    await expect(page.getByRole('heading', { name: 'SOS from Priya' })).toBeVisible();
    await expect(page.getByText('2 min ago')).toBeVisible();
    await expect(page.getByText('54%')).toBeVisible();
    await expect(page.getByText('B+')).toBeVisible();
    await expect(page.getByRole('link', { name: /Call Priya/ })).toHaveAttribute(
      'href',
      'tel:+919812344521',
    );
    await expect(page.getByRole('link', { name: 'Call 112' })).toHaveAttribute('href', 'tel:112');
    // No Maps key in tests: the place is offered as a link instead.
    await expect(
      page.getByRole('link', { name: 'Open the location in Google Maps' }),
    ).toHaveAttribute('href', /query=28\.5706,77\.3272/);
    await expect(page.getByText('Responding', { exact: true })).toBeVisible(); // Sita
    await expect(page.getByText('not a 24/7 monitoring service')).toBeVisible();

    await page.getByRole('button', { name: 'I’m responding' }).click();
    await expect(page.getByText('You’re responding.')).toBeVisible();
  });

  test('SOS: lost contact and weak GPS', async ({ page }) => {
    const view = sosView({ lostContact: true });
    view.location!.accuracyM = 350;
    await json(page, 'GET', `/g/l/${CODE}`, 200, view);
    await page.goto(`/l/${CODE}`);
    await expect(page.getByText('We lost contact with Priya’s phone.')).toBeVisible();
    await expect(page.getByText('Approximate, within 350 m')).toBeVisible();
  });

  test('SOS ended: "is safe", no buttons', async ({ page }) => {
    await json(
      page,
      'GET',
      `/g/l/${CODE}`,
      200,
      sosView({ status: 'ended', outcome: 'safe', endedAt: minutesAgo(1) }),
    );
    await page.goto(`/l/${CODE}`);
    await expect(page.getByRole('heading', { name: 'Priya is safe' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'I’m responding' })).toHaveCount(0);
  });

  test('expired link shows nothing but "This alert has ended."', async ({ page }) => {
    await json(page, 'GET', `/g/l/${CODE}`, 410, {
      error: 'link_expired',
      message: 'This alert has ended.',
    });
    await page.goto(`/l/${CODE}`);
    await expect(page.getByRole('heading', { name: 'This alert has ended.' })).toBeVisible();
    await expect(page.getByText('Open the location')).toHaveCount(0);
  });

  test('journey: destination and arrival, no SOS buttons', async ({ page }) => {
    await json(
      page,
      'GET',
      `/g/l/${CODE}`,
      200,
      sosView({
        kind: 'journey',
        person: { firstName: 'Priya', phone: null, bloodGroup: null },
        guardians: [{ firstName: 'Ravi', status: 'opened', isYou: true }],
        journey: {
          destinationLabel: 'Home',
          destination: { lat: 28.62, lng: 77.36 },
          expectedArrivalAt: '2026-11-02T17:58:00Z',
          route: null,
        },
      }),
    );
    await page.goto(`/l/${CODE}`);
    await expect(page.getByRole('heading', { name: 'Priya is on the way to Home' })).toBeVisible();
    await expect(page.getByText('11:28 pm')).toBeVisible(); // 17:58 UTC in India time
    await expect(page.getByRole('link', { name: 'Call 112' })).toHaveCount(0);
    await expect(page.getByText('Blood group')).toHaveCount(0);
  });

  test('journey arrived', async ({ page }) => {
    await json(
      page,
      'GET',
      `/g/l/${CODE}`,
      200,
      sosView({
        kind: 'journey',
        status: 'ended',
        outcome: 'arrived',
        person: { firstName: 'Priya', phone: null, bloodGroup: null },
        journey: {
          destinationLabel: 'Home',
          destination: { lat: 28.62, lng: 77.36 },
          expectedArrivalAt: '2026-11-02T17:58:00Z',
          route: null,
        },
      }),
    );
    await page.goto(`/l/${CODE}`);
    await expect(page.getByRole('heading', { name: 'Priya reached Home safely' })).toBeVisible();
  });
});

test('unknown address', async ({ page }) => {
  await page.goto('/something');
  await expect(page.getByRole('heading', { name: 'Link not found' })).toBeVisible();
});
