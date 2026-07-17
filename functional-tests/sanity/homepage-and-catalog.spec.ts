import { test, expect } from '../../fixtures/errorMonitor';
import { PlaceOrderPage } from '../../pages/PlaceOrderPage';
import { isBenignHardError } from '../../utils/orderFlowAssertions';
import { getTestCase } from '../../test-cases/testCaseDefinitions';

test.describe('Sanity — Homepage & Catalog', () => {
  const sanHomepage = getTestCase('SAN-001');
  test(sanHomepage.title, { tag: `@${sanHomepage.id}` }, async ({ page, errorLog }) => {
    const placeOrderPage = new PlaceOrderPage(page);

    await placeOrderPage.goto();
    await placeOrderPage.waitForReady();

    await expect(page.locator('header, [role="banner"]').first()).toBeVisible();

    const hardErrors = errorLog.filter((entry) => entry.severity === 'hard' && !isBenignHardError(entry));
    expect(hardErrors, `Unexpected hard errors on homepage load:\n${JSON.stringify(hardErrors, null, 2)}`).toHaveLength(0);
  });

  const sanCatalog = getTestCase('SAN-002');
  test(sanCatalog.title, { tag: `@${sanCatalog.id}` }, async ({ page }) => {
    const placeOrderPage = new PlaceOrderPage(page);

    await placeOrderPage.goto();
    await placeOrderPage.waitForReady();

    // Same "real, non-zero price" pattern PlaceOrderPage.waitForCatalogToLoad
    // uses internally — the persistent cart total badge always renders "₹0"
    // before anything is added, so a bare /₹\d/ match would false-positive on
    // that instead of actual catalog content.
    const priceText = page.locator('text=/₹[1-9]/').first();
    await expect(priceText).toBeVisible({ timeout: 20_000 });
  });
});
