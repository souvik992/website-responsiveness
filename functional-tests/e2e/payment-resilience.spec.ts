import { test, expect } from '../../fixtures/errorMonitor';
import { PlaceOrderPage } from '../../pages/PlaceOrderPage';
import { getTestCase } from '../../test-cases/testCaseDefinitions';

test.describe('End to End — Payment Resilience', () => {
  test.setTimeout(7 * 60_000);

  const e2ePayment = getTestCase('E2E-006');
  test(e2ePayment.title, { tag: `@${e2ePayment.id}` }, async ({ page, apiCalls, uiAlerts }) => {
    const placeOrderPage = new PlaceOrderPage(page);

    await placeOrderPage.goto();
    await placeOrderPage.waitForReady();
    await placeOrderPage.selectRandomProducts(1);
    await placeOrderPage.openCart();
    await placeOrderPage.selectDeliverySlotIfRequired();
    await placeOrderPage.ensureCartLoginCompleted(apiCalls, uiAlerts);
    await placeOrderPage.ensureDeliveryAddressAttached(apiCalls);

    // completeRazorpaySandboxPayment (inside placeOrderAndPay) already tries
    // the UPI recommended-app row first, falling back to Netbanking → Bank
    // of Baroda when the sandbox shows the QR-only UPI view instead — this
    // test just confirms whichever path the live sandbox takes still ends
    // in a confirmed order.
    const orderSummary = await placeOrderPage.placeOrderAndPay(apiCalls);

    expect(orderSummary.orderId || orderSummary.orderNumber, 'Expected a non-empty order id or number').not.toBe('');
    console.log(`[E2E-006] Payment completed via "${orderSummary.paymentMethod}".`);
  });
});
