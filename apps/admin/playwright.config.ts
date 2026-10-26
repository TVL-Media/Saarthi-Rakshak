import { defineConfig, devices } from '@playwright/test';

// The tests start their OWN server and panel on separate ports (3100 / 5174), using the test
// database and test Redis slot, so they never touch the development servers or data.
// If either port is busy, Playwright stops with an error instead of reusing it.
const API_PORT = 3100;
const PANEL_PORT = 5174;
const PANEL_URL = `http://localhost:${PANEL_PORT}`;

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: { baseURL: PANEL_URL, trace: 'retain-on-failure' },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command: 'node ../../server/dist/main.js',
      env: { NODE_ENV: 'test', PORT: String(API_PORT), ADMIN_PANEL_ORIGIN: PANEL_URL },
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: `pnpm exec vite --port ${PANEL_PORT} --strictPort`,
      env: { VITE_API_URL: `http://localhost:${API_PORT}` },
      url: PANEL_URL,
      reuseExistingServer: false,
    },
  ],
});
