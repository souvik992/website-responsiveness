import { test, expect } from '../../fixtures/errorMonitor';
import { PlaceOrderPage } from '../../pages/PlaceOrderPage';
import { getTestCase } from '../../test-cases/testCaseDefinitions';

test.describe('End to End — Delivery Slot', () => {
  test.setTimeout(7 * 60_000);

  const e2eSlot = getTestCase('E2E-003');
  test(e2eSlot.title, { tag: `@${e2eSlot.id}` }, async ({ page, apiCalls, uiAlerts }) => {
    const placeOrderPage = new PlaceOrderPage(page);

    await placeOrderPage.goto();
    await placeOrderPage.waitForReady();
    await placeOrderPage.selectRandomProducts(1);
    await placeOrderPage.openCart();
    // Selects a slot if the "Schedule Delivery" drawer is open; no-ops
    // otherwise — either way the flow below must still reach a confirmed
    // order.
    await placeOrderPage.selectDeliverySlotIfRequired();
    await placeOrderPage.ensureCartLoginCompleted(apiCalls, uiAlerts);
    await placeOrderPage.ensureDeliveryAddressAttached(apiCalls);
    const orderSummary = await placeOrderPage.placeOrderAndPay(apiCalls);

    expect(orderSummary.orderId || orderSummary.orderNumber, 'Expected a non-empty order id or number').not.toBe('');
  });
});
