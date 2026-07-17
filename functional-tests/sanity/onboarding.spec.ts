import { test, expect } from '../../fixtures/errorMonitor';
import { PlaceOrderPage } from '../../pages/PlaceOrderPage';
import { getTestCase } from '../../test-cases/testCaseDefinitions';

test.describe('Sanity — Onboarding', () => {
  const sanOnboarding = getTestCase('SAN-005');
  test(sanOnboarding.title, { tag: `@${sanOnboarding.id}` }, async ({ page }) => {
    const placeOrderPage = new PlaceOrderPage(page);

    await placeOrderPage.goto();
    // waitForReady() already drives the header address-chip click that
    // triggers (and, via handleOrderTypeModalIfPresent, completes) the
    // Delivery/Takeaway + address onboarding chain when it appears — see
    // pages/PlaceOrderPage.ts's setDeliveryLocationViaSearch(). This test
    // just confirms none of it is left open afterward.
    await placeOrderPage.waitForReady();

    await expect(page.getByText(/how do you want your order/i)).toBeHidden();
    await expect(page.getByText(/set delivery address/i)).toBeHidden();

    // Catalog is usable: at least one real "Add" button is visible.
    const addButton = page.locator('button:has-text("Add")').first();
    await expect(addButton).toBeVisible({ timeout: 15_000 });
  });
});
