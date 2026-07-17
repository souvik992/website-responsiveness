import { test, expect } from '../../fixtures/errorMonitor';
import { PlaceOrderPage } from '../../pages/PlaceOrderPage';
import { getTestCase } from '../../test-cases/testCaseDefinitions';

test.describe('End to End — Order Variations', () => {
  test.setTimeout(7 * 60_000);

  const e2eSingle = getTestCase('E2E-001');
  test(e2eSingle.title, { tag: `@${e2eSingle.id}` }, async ({ page, apiCalls, uiAlerts }) => {
    const placeOrderPage = new PlaceOrderPage(page);

    await placeOrderPage.goto();
    await placeOrderPage.waitForReady();
    await placeOrderPage.selectRandomProducts(1);
    await placeOrderPage.openCart();
    await placeOrderPage.selectDeliverySlotIfRequired();
    await placeOrderPage.ensureCartLoginCompleted(apiCalls, uiAlerts);
    await placeOrderPage.ensureDeliveryAddressAttached(apiCalls);
    const orderSummary = await placeOrderPage.placeOrderAndPay(apiCalls);

    expect(orderSummary.orderId || orderSummary.orderNumber, 'Expected a non-empty order id or number').not.toBe('');
    expect(orderSummary.paymentMethod, 'Expected a recognized payment method').not.toBe('');
  });

  const e2eMulti = getTestCase('E2E-002');
  test(e2eMulti.title, { tag: `@${e2eMulti.id}` }, async ({ page, apiCalls, uiAlerts }) => {
    const placeOrderPage = new PlaceOrderPage(page);

    await placeOrderPage.goto();
    await placeOrderPage.waitForReady();
    const products = await placeOrderPage.selectRandomProducts(2);
    expect(products, 'Expected 2 distinct products to be added to the cart').toHaveLength(2);

    await placeOrderPage.openCart();
    await placeOrderPage.selectDeliverySlotIfRequired();
    await placeOrderPage.ensureCartLoginCompleted(apiCalls, uiAlerts);
    await placeOrderPage.ensureDeliveryAddressAttached(apiCalls);
    const orderSummary = await placeOrderPage.placeOrderAndPay(apiCalls);

    expect(orderSummary.orderId || orderSummary.orderNumber, 'Expected a non-empty order id or number').not.toBe('');
  });
});
