import path from 'path';
import { test, chromium, firefox, webkit, devices, Browser, Page } from '@playwright/test';
import { mobileDeviceNames, tabletDeviceNames, landscapeDeviceNames, BrowserEngine } from '../utils/deviceMatrix';
import { attachConsoleErrorCollector, runResponsiveChecks } from '../utils/deviceChecks';
import { attachApiCallMonitor, attachErrorLogMonitor, attachUiAlertMonitor } from '../utils/pageMonitors';
import { PlaceOrderPage } from '../pages/PlaceOrderPage';
import { isBenignHardError } from '../utils/orderFlowAssertions';
import { writeResult, screenshotDirFor } from '../utils/deviceOrders/resultsStore';
import { DeviceOrderResult } from '../utils/deviceOrders/types';

/**
 * Places a real order (catalog → cart → OTP login → address → delivery slot
 * → Razorpay payment) on every mobile/tablet/landscape device Playwright
 * ships, capturing a screenshot of every major screen into its own
 * per-device folder and a device-compatibility signal (same checks
 * tests/responsive-visual.spec.ts uses) alongside the order-placement
 * result, merged into one Excel report by utils/deviceOrders/globalTeardown.
 *
 * This is the full device matrix (~200 cases) run one device at a time —
 * see test.describe.configure below for why serial, not parallel.
 *
 * Run standalone: npx playwright test tests/place-order-device-matrix.spec.ts --project=device-orders
 */
const BASE_URL = process.env.BASE_URL || 'https://restaurant-website-delivery-takeaway-default-template.replit.app';
// Empire Brookfield, Bengaluru — same coordinate used elsewhere in this
// project, confirmed serviceable.
const GEOLOCATION = { latitude: 12.9479978, longitude: 77.7124131 };

interface DeviceCase {
  id: string;
  deviceName: string;
  browserType: BrowserEngine;
  viewport: { width: number; height: number };
  category: 'mobile' | 'tablet' | 'landscape';
  deviceDescriptor: (typeof devices)[string];
}

function slugify(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
}

function categoryFor(name: string): DeviceCase['category'] {
  if (landscapeDeviceNames.includes(name)) return 'landscape';
  if (tabletDeviceNames.includes(name)) return 'tablet';
  return 'mobile';
}

function buildDeviceMatrix(): DeviceCase[] {
  return [...mobileDeviceNames, ...tabletDeviceNames, ...landscapeDeviceNames].map((deviceName) => {
    const d = devices[deviceName];
    return {
      id: `device__${slugify(deviceName)}`,
      deviceName,
      browserType: d.defaultBrowserType as BrowserEngine,
      viewport: d.viewport,
      category: categoryFor(deviceName),
      deviceDescriptor: d,
    };
  });
}

console.log(`[device-orders] Placing an order on ${buildDeviceMatrix().length} device(s).`);

const launchers: Record<BrowserEngine, (headless: boolean) => Promise<Browser>> = {
  chromium: (headless) => chromium.launch({ headless }),
  webkit: (headless) => webkit.launch({ headless }),
  firefox: (headless) => firefox.launch({ headless }),
};

/**
 * Closes a browser against a hard deadline — if `close()` doesn't resolve
 * in time, this returns anyway rather than blocking the test indefinitely
 * (Playwright's public `Browser` API has no way to force-kill the
 * underlying OS process directly, so a still-wedged process may linger; the
 * point here is only to stop *our own* await chain from hanging on it).
 *
 * Confirmed live: a run that shared one long-lived browser instance across
 * all 200 devices (via a per-engine cache) hit a WebKit hang mid-flow on
 * device #35 — the test's own 8-minute timeout eventually fired, but the
 * *shared* `browser.close()` in a describe-level `afterAll` hook then hung
 * for another 60s against the same wedged process, and that second
 * (hook-level) timeout is what made Playwright abandon the remaining 165
 * devices entirely rather than just marking one device failed and moving
 * on. Launching a fresh browser per device (no cache, no shared afterAll —
 * see below) is the real fix, containing a hang to the one device that
 * caused it; this timeout is the second layer, for a dedicated per-device
 * browser whose own close() still hangs.
 */
async function closeBrowserSafely(browser: Browser, timeoutMs = 15_000): Promise<void> {
  await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, timeoutMs))]).catch(() => undefined);
}

async function captureStep(page: Page, dir: string, counter: { n: number }, name: string) {
  counter.n += 1;
  const filename = path.join(dir, `${String(counter.n).padStart(2, '0')}-${slugify(name)}.png`);
  await page.screenshot({ path: filename, fullPage: true }).catch(() => undefined);
}

test.describe('Place order across every device', () => {
  // Deliberately NOT `mode: 'serial'` — confirmed live that Playwright's
  // `--shard` can't split a serial block spanning a whole file (a shard
  // count >1 put all 200 tests in shard 1 and left every other shard empty,
  // which defeats CI parallelization entirely). Sequential execution is
  // instead enforced by running with `--workers=1` (see package.json / the
  // CI workflow) — real OTP/order/payment calls against the shared staging
  // backend and Razorpay sandbox must not race across devices within a
  // single worker, but this way `--shard` can still split the 200 tests
  // across independent CI jobs, each internally sequential via its own
  // `--workers=1`.

  for (const deviceCase of buildDeviceMatrix()) {
    test(`${deviceCase.deviceName} [${deviceCase.category}, ${deviceCase.browserType}]`, async ({}, testInfo) => {
      // Generous per-device budget: the ordinary place-order flow needs up
      // to 7 minutes on its own (see place-order.spec.ts) for the payment
      // step's internal retries; this adds screenshot/check overhead on top.
      test.setTimeout(8 * 60_000);

      const headless = testInfo.project.use.headless !== false;
      const resolution = `${deviceCase.viewport.width}x${deviceCase.viewport.height}`;
      const screenshotDir = screenshotDirFor(deviceCase.id);
      const startedAt = Date.now();
      const stepCounter = { n: 0 };

      const result: DeviceOrderResult = {
        device: deviceCase.deviceName,
        browser: deviceCase.browserType,
        resolution,
        category: deviceCase.category,
        orderStatus: 'FAIL',
        orderId: '',
        orderNumber: '',
        paymentMethod: '',
        failedStep: '',
        orderError: '',
        compatibilityStatus: 'PASS',
        compatibilityIssueType: 'None',
        compatibilityIssueDescription: '-',
        durationMs: 0,
        screenshotDir,
      };

      let currentStep = 'Launch browser context';
      // A fresh browser per device, not a shared/reused instance — see
      // closeBrowserSafely's comment for why a shared browser across all 200
      // devices previously let one device's hang take the whole run down.
      const browser = await launchers[deviceCase.browserType](headless);
      const context = await browser.newContext({
        ...deviceCase.deviceDescriptor,
        baseURL: BASE_URL,
        permissions: ['geolocation'],
        geolocation: GEOLOCATION,
      });

      try {
        const page = await context.newPage();
        const consoleErrors = attachConsoleErrorCollector(page);
        const apiCalls = attachApiCallMonitor(page);
        const errorLog = attachErrorLogMonitor(page);
        const uiAlerts = await attachUiAlertMonitor(page);
        const placeOrderPage = new PlaceOrderPage(page);

        try {
          currentStep = 'Open the site and wait for the homepage to render';
          await placeOrderPage.goto();
          await placeOrderPage.waitForReady();
          await captureStep(page, screenshotDir, stepCounter, 'homepage');

          currentStep = 'Add 2 random products to the cart';
          await placeOrderPage.selectRandomProducts(2);
          await captureStep(page, screenshotDir, stepCounter, 'products-added');

          // Device-compatibility signal (same checks tests/responsive-visual.spec.ts
          // uses) taken once the real catalog has rendered, not the loading state.
          const checks = await runResponsiveChecks(page, consoleErrors);
          result.compatibilityStatus = checks.status;
          result.compatibilityIssueType = checks.issueType;
          result.compatibilityIssueDescription = checks.issueDescription;

          currentStep = 'Open the cart';
          await placeOrderPage.openCart();
          await captureStep(page, screenshotDir, stepCounter, 'cart');

          currentStep = 'Select a delivery slot, if required';
          await placeOrderPage.selectDeliverySlotIfRequired();
          await captureStep(page, screenshotDir, stepCounter, 'delivery-slot');

          currentStep = 'Log in with OTP';
          await placeOrderPage.ensureCartLoginCompleted(apiCalls, uiAlerts);
          await captureStep(page, screenshotDir, stepCounter, 'logged-in');

          currentStep = 'Attach a delivery address';
          await placeOrderPage.ensureDeliveryAddressAttached(apiCalls);
          await captureStep(page, screenshotDir, stepCounter, 'address-attached');

          currentStep = 'Place the order and pay through the Razorpay sandbox';
          const orderSummary = await placeOrderPage.placeOrderAndPay(apiCalls);
          await captureStep(page, screenshotDir, stepCounter, 'order-confirmed');

          result.orderStatus = 'PASS';
          result.orderId = orderSummary.orderId;
          result.orderNumber = orderSummary.orderNumber;
          result.paymentMethod = orderSummary.paymentMethod;

          // A device that placed the order fine but logged real console/UI
          // errors along the way still deserves a WARNING, not a silent PASS.
          const hardUiErrors = errorLog.filter((entry) => entry.severity === 'hard' && !isBenignHardError(entry));
          if (hardUiErrors.length > 0 && result.compatibilityStatus === 'PASS') {
            result.compatibilityStatus = 'WARNING';
            result.compatibilityIssueType = 'Console Error';
            result.compatibilityIssueDescription = hardUiErrors
              .slice(0, 3)
              .map((e) => e.message)
              .join(' || ');
          }
        } catch (err) {
          result.failedStep = currentStep;
          result.orderError = err instanceof Error ? err.message : String(err);
          await captureStep(page, screenshotDir, stepCounter, 'failure');
        }
      } finally {
        result.durationMs = Date.now() - startedAt;
        writeResult(deviceCase.id, result);
        // Closing the browser closes every context/page it owns — no need
        // to separately close `context` first, and one fewer blocking call
        // that could itself hang against an already-wedged browser process.
        await closeBrowserSafely(browser);
      }

      console.log(
        `[device-orders] ${result.device} [${result.category}, ${result.browser}] — order ${result.orderStatus}` +
          `${result.orderId || result.orderNumber ? ` (${result.orderNumber || result.orderId})` : ''}, ` +
          `compatibility ${result.compatibilityStatus}${result.failedStep ? `, failed at: ${result.failedStep}` : ''} ` +
          `— ${Math.round(result.durationMs / 1000)}s`
      );
    });
  }
});
