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
      name: 'chromium',
      testIgnore: /place-order-device-matrix\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // The device-matrix suite manages its own browsers/contexts per
      // device case (see tests/place-order-device-matrix.spec.ts), so it
      // doesn't need the default per-test trace/video/screenshot context
      // every other project gets — it captures its own screenshots per step.
      name: 'device-orders',
      testMatch: /place-order-device-matrix\.spec\.ts/,
      use: { trace: 'off', video: 'off', screenshot: 'off' },
    },
  ],
});
