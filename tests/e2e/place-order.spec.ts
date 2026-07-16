import { test, expect } from '../../fixtures/errorMonitor';
import { PlaceOrderPage } from '../../pages/PlaceOrderPage';
import { isBenignHardError } from '../../utils/orderFlowAssertions';

/**
 * End-to-end "place an order" journey: browse the catalog, build a cart, log
 * in with OTP, attach a delivery address, and pay through the Razorpay
 * sandbox.
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
test.describe('Place order flow', () => {
  // The payment step now retries the whole "place order → pay" sequence
  // from scratch on failure (see PlaceOrderPage.placeOrderAndPay), which
  // needs more headroom than the rest of the flow alone would.
  test.setTimeout(7 * 60_000);

  test('places an online order end to end', async ({ page, apiCalls, errorLog, uiAlerts }) => {
    const placeOrderPage = new PlaceOrderPage(page);

    await test.step('Open the site and wait for the homepage to render', async () => {
      await placeOrderPage.goto();
      await placeOrderPage.waitForReady();
    });

    const selectedProducts = await test.step('Add 2 random products to the cart', async () => {
      return placeOrderPage.selectRandomProducts(2);
    });

    await test.step('Open the cart', async () => {
      await placeOrderPage.openCart();
    });

    await test.step('Select a delivery slot, if the cart requires one', async () => {
      await placeOrderPage.selectDeliverySlotIfRequired();
    });

    await test.step('Log in with OTP if the cart is gated behind login', async () => {
      const loggedIn = await placeOrderPage.ensureCartLoginCompleted(apiCalls, uiAlerts);
      console.log(loggedIn ? '[login] Completed OTP login for a new session.' : '[login] Already logged in — nothing to do.');
    });

    const addressText = await test.step('Attach a delivery address to the cart', async () => {
      return placeOrderPage.ensureDeliveryAddressAttached(apiCalls);
    });

    const orderSummary = await test.step('Place the order and pay through the Razorpay sandbox', async () => {
      return placeOrderPage.placeOrderAndPay(apiCalls);
    });

    await test.step('Verify the order summary looks complete', async () => {
      expect(orderSummary.orderId || orderSummary.orderNumber, 'Expected the order API to return an order id or number').not.toBe('');
      console.log(
        `[order] Placed order ${orderSummary.orderNumber || orderSummary.orderId} for products [${selectedProducts
          .map((p) => p.name)
          .join(', ')}] delivering to "${addressText}", paid via ${orderSummary.paymentMethod}.`
      );
    });

    await test.step('Report a summary of API failures and UI error alerts observed during the run', async () => {
      const failedApiCalls = apiCalls.filter((call) => call.status >= 400);
      const errorAlerts = uiAlerts.filter((alert) => alert.looksLikeError);
      const hardUiErrors = errorLog.filter((entry) => entry.severity === 'hard' && !isBenignHardError(entry));

      console.log(
        `[summary] ${apiCalls.length} API call(s) observed, ${failedApiCalls.length} failed; ` +
          `${uiAlerts.length} snackbar(s) observed, ${errorAlerts.length} looked like errors; ` +
          `${hardUiErrors.length} hard UI/console error(s).`
      );

      // Failures were already logged live as they happened (and retried up to 5x
      // where the flow depends on them); the assertion here just makes sure a
      // failure that slipped through unretried still fails the test visibly.
      expect(hardUiErrors, `Unexpected hard UI/console errors:\n${JSON.stringify(hardUiErrors, null, 2)}`).toHaveLength(0);
    });
  });
});
