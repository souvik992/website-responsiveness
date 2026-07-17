import { test, expect } from '../../fixtures/errorMonitor';
import { PlaceOrderPage } from '../../pages/PlaceOrderPage';
import { getTestCase } from '../../test-cases/testCaseDefinitions';

test.describe('End to End — Onboarding Regression', () => {
  test.setTimeout(5 * 60_000);
  const e2eOnboarding = getTestCase('E2E-005');
  test(e2eOnboarding.title, { tag: `@${e2eOnboarding.id}` }, async ({ page }) => {
    const placeOrderPage = new PlaceOrderPage(page);

    await placeOrderPage.goto();
    await placeOrderPage.waitForReady();

    // On a fresh session, the very first "Add" click can be entirely
    // consumed by the Delivery/Takeaway + address onboarding chain instead
    // of adding the item (see PlaceOrderPage.handleOrderTypeModalIfPresent).
    // selectRandomProducts already re-clicks once onboarding finishes and
    // throws if the cart count still didn't increase — a successful return
    // for both products here IS the regression check.
    const products = await placeOrderPage.selectRandomProducts(2);
    expect(products, 'Expected both products to be added despite any onboarding chain on the first click').toHaveLength(2);
  });
});
