import { defineConfig, devices } from '@playwright/test';

/**
 * Environment-driven base URL.
 * Run with: BASE_URL=https://restaurant-website-delivery-takeaway-default-template.replit.app npx playwright test
 * Defaults to the Replit demo template if not set.
 */
const BASE_URL = process.env.BASE_URL || 'https://restaurant-website-delivery-takeaway-default-template.replit.app';

export default defineConfig({
  testDir: './tests',
  // Only touches the device-order suite's own results directory; a no-op fs
  // write for every other run. See utils/deviceOrders/globalTeardown.ts.
  globalSetup: require.resolve('./utils/deviceOrders/globalSetup'),
  globalTeardown: require.resolve('./utils/deviceOrders/globalTeardown'),
  timeout: 60 * 1000,
  expect: {
    timeout: 8 * 1000,
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 4 : undefined,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10 * 1000,
    navigationTimeout: 20 * 1000,
    permissions: ['geolocation'],
    // Empire Brookfield, Bengaluru — same coordinate dumdurrust-playwright's
    // config uses, confirmed serviceable for this restaurant's address too
    // (Kundalahalli Gate / ITPL Main Rd / Brookefield, a short drive away).
    geolocation: { latitude: 12.9479978, longitude: 77.7124131 },
  },

  projects: [
    {
      name: 'mobile-chrome',
      testIgnore: /place-order-device-matrix\.spec\.ts/,
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'iphone-xr',
      testIgnore: /place-order-device-matrix\.spec\.ts/,
      use: { ...devices['iPhone XR'] },
    },
    {
      name: 'desktop-chrome',
      testIgnore: /place-order-device-matrix\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'desktop-firefox',
      testIgnore: /place-order-device-matrix\.spec\.ts/,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'desktop-webkit',
      testIgnore: /place-order-device-matrix\.spec\.ts/,
      use: { ...devices['Desktop Safari'] },
    },
    {
      // Real Microsoft Edge (not just Chrome with an Edge UA) — needs the
      // `msedge` channel installed via `playwright install msedge`.
      name: 'desktop-edge',
      testIgnore: /place-order-device-matrix\.spec\.ts/,
      use: { ...devices['Desktop Edge'], channel: 'msedge' },
    },
    {
      // Full HD — the most common external-monitor / laptop-docked resolution.
      name: 'desktop-1920x1080',
      testIgnore: /place-order-device-matrix\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1920, height: 1080 } },
    },
    {
      // Most common laptop panel resolution.
      name: 'desktop-1366x768',
      testIgnore: /place-order-device-matrix\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } },
    },
    {
      // Common 15"-16" laptop resolution, distinct aspect ratio from the above two.
      name: 'desktop-1440x900',
      testIgnore: /place-order-device-matrix\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      // The device-matrix suite manages its own browsers/contexts per
      // device case (see tests/place-order-device-matrix.spec.ts), so it
      // doesn't need the default per-test trace/video/screenshot context
      // every other project gets — it captures its own screenshots per step.
      name: 'device-orders',
      testMatch: /place-order-device-matrix\.spec\.ts/,
      // Confirmed live: a wedged browser (seen once with WebKit on a long
      // unattended run) can outlast its own test's timeout. A same-process
      // retry wouldn't help — the fix that actually contains it is a fresh
      // browser per device (no more cross-device sharing, see the spec file)
      // — but this retry is the safety net if a device's browser is *still*
      // unrecoverable: Playwright retries in a brand-new worker process,
      // which guarantees a clean slate no in-process fix could.
      retries: 1,
      use: { trace: 'off', video: 'off', screenshot: 'off' },
    },
  ],
});
