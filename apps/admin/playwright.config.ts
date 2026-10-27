import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

// The tests start their OWN servers and panels, using the test database and test Redis slot,
// so they never touch the development servers or data. Two pairs:
//   2-step on:  API 3100, panel 5174 (e2e/login.spec.ts)
//   2-step off: API 3101, panel 5175 (e2e/login-two-step-off.spec.ts)
// If a port is busy, Playwright stops with an error instead of reusing it.
const PAIRS = [
  { name: 'two-step-on', twoStep: 'on', api: 3100, panel: 5174, spec: /login\.spec\.ts/ },
  { name: 'two-step-off', twoStep: 'off', api: 3101, panel: 5175, spec: /two-step-off\.spec\.ts/ },
] as const;

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: { trace: 'retain-on-failure' },
  projects: PAIRS.map((p) => ({
    name: p.name,
    testMatch: p.spec,
    use: {
      ...devices['Desktop Chrome'],
      viewport: { width: 1440, height: 900 },
      baseURL: `http://localhost:${p.panel}`,
    },
  })),
  webServer: PAIRS.flatMap((p): NonNullable<PlaywrightTestConfig['webServer']> => [
    {
      command: 'node ../../server/dist/main.js',
      env: {
        NODE_ENV: 'test',
        PORT: String(p.api),
        ADMIN_PANEL_ORIGIN: `http://localhost:${p.panel}`,
        ADMIN_TWO_STEP: p.twoStep,
      },
      url: `http://localhost:${p.api}/health`,
      reuseExistingServer: false,
      stdout: 'ignore' as const,
      stderr: 'pipe' as const,
    },
    {
      command: `pnpm exec vite --port ${p.panel} --strictPort`,
      env: { VITE_API_URL: `http://localhost:${p.api}` },
      url: `http://localhost:${p.panel}`,
      reuseExistingServer: false,
    },
  ]),
});
