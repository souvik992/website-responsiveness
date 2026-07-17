import { test, expect } from '../../fixtures/errorMonitor';
import { PlaceOrderPage } from '../../pages/PlaceOrderPage';
import { expectSuccessfulApiCall } from '../../utils/orderFlowAssertions';
import { getTestCase } from '../../test-cases/testCaseDefinitions';

// Same endpoint pattern PlaceOrderPage.saveNewCurrentLocationAddress uses
// internally (pages/PlaceOrderPage.ts:948).
const SAVE_ADDRESS_PATTERN = /address\/v1\/create/i;
// The primary deployment's order-confirmation lookup (pages/PlaceOrderPage.ts
// :1093-1094) — the same one placeOrderAndPay itself uses to build the
// returned OrderSummary, so this is the same signal, not a re-derivation.
const ORDER_PATTERN = /order/i;

test.describe('API Testing — Address & Order', () => {
  test.setTimeout(7 * 60_000);

  const apiAddress = getTestCase('API-003');
  test(apiAddress.title, { tag: `@${apiAddress.id}` }, async ({ page, apiCalls, uiAlerts }) => {
    const placeOrderPage = new PlaceOrderPage(page);

    await placeOrderPage.goto();
    await placeOrderPage.waitForReady();
    await placeOrderPage.selectRandomProducts(1);
    await placeOrderPage.openCart();
    await placeOrderPage.selectDeliverySlotIfRequired();
    await placeOrderPage.ensureCartLoginCompleted(apiCalls, uiAlerts);
    const addressText = await placeOrderPage.ensureDeliveryAddressAttached(apiCalls);

    expect(addressText, 'Expected a non-empty attached delivery address').not.toBe('');

    const saveAddressCall = apiCalls.find((call) => SAVE_ADDRESS_PATTERN.test(call.url));
    expect(saveAddressCall, 'Expected a save-address API call to have been captured').toBeDefined();
    expectSuccessfulApiCall(saveAddressCall!, 'Save delivery address');
  });

  const apiOrder = getTestCase('API-004');
  test(apiOrder.title, { tag: `@${apiOrder.id}` }, async ({ page, apiCalls, uiAlerts }) => {
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

    const orderCall = apiCalls
      .slice()
      .reverse()
      .find((call) => ORDER_PATTERN.test(call.url) && call.status < 400);
    expect(orderCall, 'Expected a successful order-related API call to have been captured').toBeDefined();
  });
});
