import path from 'path';
import type { Page } from '@playwright/test';
import { test } from '../../fixtures/errorMonitor';
import { PlaceOrderPage } from '../../pages/PlaceOrderPage';
import { isBenignHardError } from '../../utils/orderFlowAssertions';
import { attachConsoleErrorCollector, runResponsiveChecks } from '../../utils/deviceChecks';
import { writeResult, screenshotDirFor } from '../../utils/deviceOrders/resultsStore';
import { DeviceOrderResult } from '../../utils/deviceOrders/types';

/**
 * End-to-end "place an order" journey: browse the catalog, build a cart, log
 * in with OTP, attach a delivery address, and pay through the Razorpay
 * sandbox.
 *
 * Every step is caught rather than thrown — a failure anywhere in the flow
 * is recorded into the same device-order result/report the device-matrix
 * suite uses (see utils/deviceOrders/*) instead of failing the Playwright
 * run, so a single flaky project doesn't red the whole test run; the Excel
 * report (test-results/device-order-report.xlsx, rebuilt automatically by
 * globalTeardown) is the source of truth for pass/fail per browser project.
 *
 * Throughout the run:
 *  - every failing API call is logged to the console the moment it happens
 *    (see fixtures/errorMonitor.ts's `apiCalls` fixture);
 *  - every error snackbar/toast is logged to the console the moment it
 *    appears (see the `uiAlerts` fixture);
 *  - any UI action that triggers a backend call is retried up to 5 times if
 *    that call fails, since the staging backend sometimes needs a couple of
 *    hits to "wake up" (see utils/apiRetry.ts);
 *  - OTP login restarts from the mobile-number screen if verification is
 *    ever rejected.
 */
async function captureStep(page: Page, dir: string, counter: { n: number }, name: string) {
  counter.n += 1;
  const filename = path.join(dir, `${String(counter.n).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')}.png`);
  await page.screenshot({ path: filename, fullPage: true }).catch(() => undefined);
}

test.describe('Place order flow', () => {
  // The payment step retries the whole "place order → pay" sequence from
  // scratch on failure (see PlaceOrderPage.placeOrderAndPay), which needs
  // more headroom than the rest of the flow alone would.
  test.setTimeout(7 * 60_000);

  test('places an online order end to end', async ({ page, apiCalls, errorLog, uiAlerts }, testInfo) => {
    const placeOrderPage = new PlaceOrderPage(page);
    const projectName = testInfo.project.name;
    const viewport = page.viewportSize();
    const id = `desktop__${projectName}`;
    const screenshotDir = screenshotDirFor(id);
    const startedAt = Date.now();
    const stepCounter = { n: 0 };

    const result: DeviceOrderResult = {
      device: projectName,
      browser: projectName,
      resolution: viewport ? `${viewport.width}x${viewport.height}` : '',
      category: 'desktop',
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

    // Must be attached before navigation — console/pageerror events fire
    // during page load, before runResponsiveChecks below gets a chance to look.
    const consoleErrors = attachConsoleErrorCollector(page);

    let currentStep = 'Open the site and wait for the homepage to render';
    try {
      await placeOrderPage.goto();
      await placeOrderPage.waitForReady();
      await captureStep(page, screenshotDir, stepCounter, 'homepage');

      currentStep = 'Add 1 random product to the cart';
      const selectedProducts = await placeOrderPage.selectRandomProducts(1);
      await captureStep(page, screenshotDir, stepCounter, 'product-added');

      // Device-compatibility signal (same checks tests/place-order-device-matrix.spec.ts
      // uses) taken once the real catalog has rendered, not the loading state.
      const checks = await runResponsiveChecks(page, consoleErrors);
      result.compatibilityStatus = checks.status;
      result.compatibilityIssueType = checks.issueType;
      result.compatibilityIssueDescription = checks.issueDescription;

      currentStep = 'Open the cart';
      await placeOrderPage.openCart();
      await captureStep(page, screenshotDir, stepCounter, 'cart');

      currentStep = 'Select a delivery slot, if the cart requires one';
      await placeOrderPage.selectDeliverySlotIfRequired();

      currentStep = 'Log in with OTP if the cart is gated behind login';
      const loggedIn = await placeOrderPage.ensureCartLoginCompleted(apiCalls, uiAlerts);
      console.log(loggedIn ? '[login] Completed OTP login for a new session.' : '[login] Already logged in — nothing to do.');
      await captureStep(page, screenshotDir, stepCounter, 'logged-in');

      currentStep = 'Attach a delivery address to the cart';
      const addressText = await placeOrderPage.ensureDeliveryAddressAttached(apiCalls);
      await captureStep(page, screenshotDir, stepCounter, 'address-attached');

      currentStep = 'Place the order and pay through the Razorpay sandbox';
      const orderSummary = await placeOrderPage.placeOrderAndPay(apiCalls);
      await captureStep(page, screenshotDir, stepCounter, 'order-confirmed');

      if (!orderSummary.orderId && !orderSummary.orderNumber) {
        throw new Error('Order API did not return an order id or number.');
      }

      result.orderStatus = 'PASS';
      result.orderId = orderSummary.orderId;
      result.orderNumber = orderSummary.orderNumber;
      result.paymentMethod = orderSummary.paymentMethod;

      console.log(
        `[order] Placed order ${orderSummary.orderNumber || orderSummary.orderId} for product "${selectedProducts[0]?.name}" ` +
          `delivering to "${addressText}", paid via ${orderSummary.paymentMethod}.`
      );

      // An order that placed fine but logged real console/UI errors along
      // the way still deserves a WARNING, not a silent PASS — but not if
      // runResponsiveChecks above already found something worse (FAIL).
      const failedApiCalls = apiCalls.filter((call) => call.status >= 400);
      const errorAlerts = uiAlerts.filter((alert) => alert.looksLikeError);
      const hardUiErrors = errorLog.filter((entry) => entry.severity === 'hard' && !isBenignHardError(entry));
      console.log(
        `[summary] ${apiCalls.length} API call(s) observed, ${failedApiCalls.length} failed; ` +
          `${uiAlerts.length} snackbar(s) observed, ${errorAlerts.length} looked like errors; ` +
          `${hardUiErrors.length} hard UI/console error(s).`
      );
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
      // A failure before runResponsiveChecks ran (e.g. the site never loaded)
      // would otherwise leave the Summary sheet's Compatibility Issue
      // Description column at its default '-', hiding the real error from
      // anyone scanning that column alone. Only fills in if nothing worse
      // (an actual layout/console issue) was already found.
      if (result.compatibilityStatus === 'PASS') {
        result.compatibilityStatus = 'FAIL';
        result.compatibilityIssueType = 'Order Error';
        result.compatibilityIssueDescription = `Failed at "${currentStep}": ${result.orderError}`;
      }
      await captureStep(page, screenshotDir, stepCounter, 'failure');
      console.error(`[order] FAILED at "${currentStep}": ${result.orderError}`);
    } finally {
      result.durationMs = Date.now() - startedAt;
      writeResult(id, result);
    }

    console.log(
      `[order-report] ${result.browser} — order ${result.orderStatus}` +
        `${result.orderId || result.orderNumber ? ` (${result.orderNumber || result.orderId})` : ''}, ` +
        `compatibility ${result.compatibilityStatus}${result.failedStep ? `, failed at: ${result.failedStep}` : ''} ` +
        `— ${Math.round(result.durationMs / 1000)}s`
    );
  });
});
