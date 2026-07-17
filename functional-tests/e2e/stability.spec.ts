import { test, expect } from '../../fixtures/errorMonitor';
import { PlaceOrderPage } from '../../pages/PlaceOrderPage';
import { isBenignHardError } from '../../utils/orderFlowAssertions';
import { getTestCase } from '../../test-cases/testCaseDefinitions';

test.describe('End to End — Stability', () => {
  test.setTimeout(7 * 60_000);

  const e2eStability = getTestCase('E2E-004');
  test(e2eStability.title, { tag: `@${e2eStability.id}` }, async ({ page, apiCalls, uiAlerts, errorLog }) => {
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

    const hardErrors = errorLog.filter((entry) => entry.severity === 'hard' && !isBenignHardError(entry));
    expect(hardErrors, `Unexpected hard UI/console errors across the journey:\n${JSON.stringify(hardErrors, null, 2)}`).toHaveLength(0);
  });
});
