import { defineConfig, devices } from '@playwright/test';

// The page is tested on its own with the server's replies faked in each test (page.route), so no
// server or database is needed. Port 5176 so it never clashes with the dev page on 5175.
const PORT = 5176;

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    ...devices['Pixel 7'],
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    // No server behind the proxy and no Maps key: the tests fake the API; the map falls back.
    env: { VITE_API_URL: 'http://127.0.0.1:9', VITE_GOOGLE_MAPS_API_KEY: '' },
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
  },
});
