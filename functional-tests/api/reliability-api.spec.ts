import { test, expect } from '../../fixtures/errorMonitor';
import { PlaceOrderPage } from '../../pages/PlaceOrderPage';
import { assertNoUiOrApiErrors } from '../../utils/orderFlowAssertions';
import { getTestCase } from '../../test-cases/testCaseDefinitions';

test.describe('API Testing — Reliability', () => {
  test.setTimeout(7 * 60_000);

  const apiReliability = getTestCase('API-005');
  test(apiReliability.title, { tag: `@${apiReliability.id}` }, async ({ page, apiCalls, uiAlerts, errorLog }) => {
    const placeOrderPage = new PlaceOrderPage(page);

    await placeOrderPage.goto();
    await placeOrderPage.waitForReady();
    await placeOrderPage.selectRandomProducts(1);
    await placeOrderPage.openCart();
    await placeOrderPage.selectDeliverySlotIfRequired();
    await placeOrderPage.ensureCartLoginCompleted(apiCalls, uiAlerts);
    await placeOrderPage.ensureDeliveryAddressAttached(apiCalls);
    const orderSummary = await placeOrderPage.placeOrderAndPay(apiCalls);
    expect(orderSummary.orderId || orderSummary.orderNumber).not.toBe('');

    assertNoUiOrApiErrors(errorLog, apiCalls);
  });
});
