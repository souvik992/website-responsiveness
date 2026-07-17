import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

/**
 * Environment-driven base URL.
 * Run with: BASE_URL=https://restaurant-website-delivery-takeaway-default-template.replit.app npx playwright test
 * Defaults to the Replit demo template if not set.
 */
const BASE_URL = process.env.BASE_URL || 'https://restaurant-website-delivery-takeaway-default-template.replit.app';

type ProjectConfig = NonNullable<PlaywrightTestConfig['projects']>[number];

const DESKTOP_ENGINES: { name: string; device: string; channel?: string }[] = [
  { name: 'chrome', device: 'Desktop Chrome' },
  { name: 'firefox', device: 'Desktop Firefox' },
  { name: 'webkit', device: 'Desktop Safari' },
  // Real Microsoft Edge (not just Chrome with an Edge UA) — needs the
  // `msedge` channel installed via `playwright install msedge`.
  { name: 'edge', device: 'Desktop Edge', channel: 'msedge' },
];

const DESKTOP_RESOLUTIONS: { label: string; viewport: { width: number; height: number } }[] = [
  // Full HD — the most common external-monitor / laptop-docked resolution.
  { label: '1920x1080', viewport: { width: 1920, height: 1080 } },
  // Most common laptop panel resolution.
  { label: '1366x768', viewport: { width: 1366, height: 768 } },
  // Common 15"-16" laptop resolution, distinct aspect ratio from the above two.
  { label: '1440x900', viewport: { width: 1440, height: 900 } },
];

/**
 * One project per browser at its default (1280x720) viewport, plus one per
 * browser × resolution combination — a real cross-product, not just
 * resolution variants of Chrome, so a layout bug specific to e.g. Firefox at
 * 1366x768 isn't invisible to this suite.
 */
function buildDesktopProjects(): ProjectConfig[] {
  const projects: ProjectConfig[] = DESKTOP_ENGINES.map(({ name, device, channel }) => ({
    name: `desktop-${name}`,
    testIgnore: /place-order-device-matrix\.spec\.ts/,
    use: { ...devices[device], ...(channel ? { channel } : {}) },
  }));

  for (const { name, device, channel } of DESKTOP_ENGINES) {
    for (const { label, viewport } of DESKTOP_RESOLUTIONS) {
      projects.push({
        name: `desktop-${name}-${label}`,
        testIgnore: /place-order-device-matrix\.spec\.ts/,
        use: { ...devices[device], ...(channel ? { channel } : {}), viewport },
      });
    }
  }

  return projects;
}

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
    ['json', { outputFile: 'test-results/results.json' }],
    ['allure-playwright', { outputFolder: 'allure-results' }],
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
    ...buildDesktopProjects(),
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
    {
      // Sanity/E2E/API functional test-case suite (see functional-tests/ and
      // test-cases/testCaseDefinitions.ts). Deliberately a sibling directory
      // outside the shared `./tests` testDir, not a testIgnore exclusion on
      // the projects above — this project's own testDir means the other 18
      // projects above never see these files, and nothing about their
      // existing behavior changes.
      name: 'functional-suite',
      testDir: './functional-tests',
      // Confirmed live: even the non-order-placing cases (homepage/catalog/
      // cart/onboarding) can outlast the global 60s default under real
      // staging-site load — waitForReady()'s own "not deliverable, retry"
      // loop alone can take a while. Order-placing cases still set their own
      // longer test.setTimeout() to match placeOrderAndPay's retry budget.
      timeout: 3 * 60_000,
      // Same justification as device-orders above: confirmed live that a
      // full 17-case run against the shared live staging backend can hit a
      // one-off transient miss (a random add-to-cart badge lag, a slow
      // navigation) on a case that passes cleanly on its own — a fresh
      // worker-process retry filters that out from a genuine regression.
      retries: 1,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
