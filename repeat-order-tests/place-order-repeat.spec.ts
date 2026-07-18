import path from 'path';
import type { Page } from '@playwright/test';
import { test } from '../fixtures/errorMonitor';
import { PlaceOrderPage } from '../pages/PlaceOrderPage';
import { isBenignHardError } from '../utils/orderFlowAssertions';
import { attachConsoleErrorCollector, runResponsiveChecks } from '../utils/deviceChecks';
import { writeResult, screenshotDirFor } from '../utils/deviceOrders/resultsStore';
import { DeviceOrderResult } from '../utils/deviceOrders/types';

/**
 * Places N independent real orders back-to-back on a single browser project
 * — how many is controlled by the "Place Order" GitHub Actions workflow's
 * `order_count` input (mapped to Playwright's own `--repeat-each` flag, not
 * a hand-rolled loop), not by device/browser variety. Each repetition gets
 * a fresh browser context (that's what `--repeat-each` does — reruns the
 * whole test, including the `page` fixture, from scratch) and its own row
 * in the shared device-order Excel report (see utils/deviceOrders/*), keyed
 * by attempt number so results/screenshots from different repetitions never
 * collide.
 *
 * Run standalone: npx playwright test --project=place-order-repeat --repeat-each=5
 */
async function captureStep(page: Page, dir: string, counter: { n: number }, name: string) {
  counter.n += 1;
  const filename = path.join(dir, `${String(counter.n).padStart(2, '0')}-${name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')}.png`);
  await page.screenshot({ path: filename, fullPage: true }).catch(() => undefined);
}

test.describe('Place order — repeat N times', () => {
  // Same budget as tests/e2e/place-order.spec.ts's single order — the
  // payment step's own internal retries need the headroom.
  test.setTimeout(7 * 60_000);

  test('places an online order end to end', async ({ page, apiCalls, errorLog, uiAlerts }, testInfo) => {
    const placeOrderPage = new PlaceOrderPage(page);
    const attempt = testInfo.repeatEachIndex + 1; // 0-based -> 1-based, for readable ids/logs
    const id = `repeat-order__${String(attempt).padStart(3, '0')}`;
    const screenshotDir = screenshotDirFor(id);
    const viewport = page.viewportSize();
    const startedAt = Date.now();
    const stepCounter = { n: 0 };

    const result: DeviceOrderResult = {
      device: `Order #${attempt}`,
      browser: testInfo.project.name,
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

      // Device-compatibility signal (same checks the device-matrix/desktop
      // suites use) taken once the real catalog has rendered.
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
      await placeOrderPage.ensureCartLoginCompleted(apiCalls, uiAlerts);
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
        `[order ${attempt}] Placed order ${orderSummary.orderNumber || orderSummary.orderId} for product "${selectedProducts[0]?.name}" ` +
          `delivering to "${addressText}", paid via ${orderSummary.paymentMethod}.`
      );

      // An order that placed fine but logged real console/UI errors along
      // the way still deserves a WARNING, not a silent PASS.
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
      if (result.compatibilityStatus === 'PASS') {
        result.compatibilityStatus = 'FAIL';
        result.compatibilityIssueType = 'Order Error';
        result.compatibilityIssueDescription = `Failed at "${currentStep}": ${result.orderError}`;
      }
      await captureStep(page, screenshotDir, stepCounter, 'failure');
      console.error(`[order ${attempt}] FAILED at "${currentStep}": ${result.orderError}`);
    } finally {
      result.durationMs = Date.now() - startedAt;
      writeResult(id, result);
    }

    console.log(
      `[order-report] Order #${attempt} — ${result.orderStatus}` +
        `${result.orderId || result.orderNumber ? ` (${result.orderNumber || result.orderId})` : ''}, ` +
        `compatibility ${result.compatibilityStatus}${result.failedStep ? `, failed at: ${result.failedStep}` : ''} ` +
        `— ${Math.round(result.durationMs / 1000)}s`
    );
  });
});
