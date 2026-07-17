import { test, expect } from '../../fixtures/errorMonitor';
import { PlaceOrderPage } from '../../pages/PlaceOrderPage';
import { getTestCase } from '../../test-cases/testCaseDefinitions';

test.describe('Sanity — Order Placement', () => {
  const sanOrder = getTestCase('SAN-006');
  test(sanOrder.title, { tag: `@${sanOrder.id}` }, async ({ page, apiCalls, uiAlerts }) => {
    // Matches the payment step's own retry headroom in PlaceOrderPage.placeOrderAndPay.
    test.setTimeout(7 * 60_000);
    const placeOrderPage = new PlaceOrderPage(page);

    await placeOrderPage.goto();
    await placeOrderPage.waitForReady();
    await placeOrderPage.selectRandomProducts(1);
    await placeOrderPage.openCart();
    await placeOrderPage.selectDeliverySlotIfRequired();
    await placeOrderPage.ensureCartLoginCompleted(apiCalls, uiAlerts);
    await placeOrderPage.ensureDeliveryAddressAttached(apiCalls);
    const orderSummary = await placeOrderPage.placeOrderAndPay(apiCalls);

    expect(orderSummary.orderId || orderSummary.orderNumber, 'Expected the order API to return an order id or number').not.toBe('');
    console.log(`[SAN-006] Placed order ${orderSummary.orderNumber || orderSummary.orderId}, paid via ${orderSummary.paymentMethod}.`);
  });
});
