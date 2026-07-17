import { test, expect } from '../../fixtures/errorMonitor';
import { PlaceOrderPage } from '../../pages/PlaceOrderPage';
import { getTestCase } from '../../test-cases/testCaseDefinitions';

test.describe('Sanity — Cart', () => {
  const sanAddToCart = getTestCase('SAN-003');
  test(sanAddToCart.title, { tag: `@${sanAddToCart.id}` }, async ({ page }) => {
    const placeOrderPage = new PlaceOrderPage(page);

    await placeOrderPage.goto();
    await placeOrderPage.waitForReady();

    // selectRandomProducts already throws if the cart badge doesn't increase
    // after the add click — a successful return here IS the pass condition.
    const products = await placeOrderPage.selectRandomProducts(1);
    expect(products).toHaveLength(1);
  });

  const sanOpenCart = getTestCase('SAN-004');
  test(sanOpenCart.title, { tag: `@${sanOpenCart.id}` }, async ({ page }) => {
    const placeOrderPage = new PlaceOrderPage(page);

    await placeOrderPage.goto();
    await placeOrderPage.waitForReady();
    const [product] = await placeOrderPage.selectRandomProducts(1);

    await placeOrderPage.openCart();

    await expect(page.getByText(product.name, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  });
});
