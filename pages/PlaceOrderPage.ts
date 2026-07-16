import { expect, type FrameLocator, type Locator, type Page } from '@playwright/test';

import type { ApiCall, UiAlert } from '../fixtures/errorMonitor';
import { retryUntilApiSucceeds } from '../utils/apiRetry';
import {
  expectSuccessfulApiCall,
  extractOtpFromResponse,
  findLatestApiCall,
  findTextInObject,
  normalizeText,
} from '../utils/orderFlowAssertions';

export type SelectedProduct = { name: string; priceText: string };

export type OrderSummary = {
  orderId: string;
  orderNumber: string;
  paymentMethod: string;
  status: string;
  addressText: string;
};

/** Delivery address details used whenever the flow needs to save a fresh address. */
const NEW_ADDRESS_DETAILS = {
  buildingName: 'Tower 12, Flat 4B',
  landmark: 'Near City Park',
  addressType: 'Home' as const,
};

/**
 * Drives the customer-facing "place an order" journey end to end: browse the
 * catalog, build a cart, log in with OTP, attach a delivery address, pay
 * through the Razorpay sandbox, and land on the order-confirmation screen.
 *
 * Every step that talks to the backend is wrapped so that a failing API call
 * retries the *user action* (not just the request) up to 5 times — the
 * staging backend this suite targets sometimes needs a couple of hits to
 * "wake up". OTP login additionally restarts from the mobile-number screen
 * if verification is rejected, matching what a real user would do.
 */
export class PlaceOrderPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Navigation & page readiness
  // ─────────────────────────────────────────────────────────────────────

  async goto() {
    // This deployment's SPA only mounts at /home — the root path ('/') is
    // served but never renders anything into #root (confirmed live: still
    // an empty div after a 5s wait), unlike dumdurrust.stage where '/' works.
    await this.page.goto('/home', { waitUntil: 'domcontentloaded' });
  }

  /**
   * Waits for the app shell to render, clears any first-load modal, and
   * explicitly sets the delivery location via the header's address search
   * (typing and selecting a known-serviceable suggestion), rather than
   * relying on the browser's geolocation permission to auto-resolve one —
   * that automatic path has proven unreliable (occasionally flaky, and can
   * degrade into consistent failures), while an explicit address search goes
   * through the same flow a real user would use to fix a bad location.
   */
  async waitForReady() {
    await this.page
      .locator('header, [role="banner"], main, #root')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
    await this.dismissBlockingModal();
    await this.setDeliveryLocationViaSearch();
  }

  /**
   * Explicitly sets the delivery location by typing into the location
   * picker's address search and selecting a known-serviceable suggestion,
   * instead of relying on the browser's geolocation permission to
   * auto-resolve one — that automatic path has proven unreliable
   * (occasionally flaky, and can degrade into consistent failures across a
   * whole run). Deliberately kept to a handful of targeted selectors for the
   * specific controls this flow needs, rather than the broad DOM-eval "click
   * anything that looks close" fallbacks used elsewhere in this codebase for
   * a similar overlay — those are wide enough to land on unrelated header
   * controls, which is worse than doing nothing on a control we can't find.
   *
   * Confirmed live on this deployment (differs from dumdurrust.stage):
   *  - The "Find <Restaurant> Near You" picker offers two entry points —
   *    "Use Current Location" and "Enter your Location Manually" — and only
   *    the latter reveals the search input; there's no separate
   *    "current location" button that also opens search the way
   *    dumdurrust.stage's does.
   *  - The search input's placeholder reads "Search for area, street name or
   *    pincode", not "...district or pincode".
   *  - Suggestions render as plain `<li>` items with build-hashed CSS-module
   *    class names (no `role="option"`/`role="listbox"`, no
   *    `.pac-container`/`.MuiAutocomplete-option`) — scoped by DOM position
   *    (two ancestors up from the search input) rather than by class, since
   *    those hashes aren't stable across builds.
   *  - Clicking a suggestion immediately resolves the location and closes
   *    the picker on its own — there's no separate "Confirm"/"Continue"
   *    button to click afterward.
   */
  private async setDeliveryLocationViaSearch(address = 'empire brookfield') {
    const manualEntryButton = this.page.getByRole('button', { name: /enter your location manually/i }).first();

    if (!(await this.waitVisible(manualEntryButton, 5_000))) {
      // Picker isn't already open (e.g. a location was set on an earlier
      // visit) — reopen it via the header's address chip first.
      const addressOpener = this.page
        .locator('[role="banner"], header')
        .first()
        .getByText(/india|bengaluru|karnataka|560\d{3}|delivery|change address/i)
        .first();
      if (await this.waitVisible(addressOpener, 5_000)) {
        await addressOpener.click().catch(() => undefined);
        // Confirmed live: clicking the header's address/delivery chip is what
        // actually triggers the "How do you want your order?" onboarding
        // chain (not the "Add" click it was first found blocking) — dismiss
        // it here, where it's actually caused, rather than only opportunistically
        // later. Left unhandled, it sits on top of the location picker and
        // "Enter your Location Manually" never becomes visible below.
        await this.handleOrderTypeModalIfPresent();
      }
    }

    if (await this.waitVisible(manualEntryButton, 5_000)) {
      await manualEntryButton.click();
    }

    const searchInput = this.page
      .locator('input.pac-target-input, input#searchboxinput, input[placeholder*="Search for area" i]')
      .first();
    if (!(await this.waitVisible(searchInput, 10_000))) {
      return; // couldn't find the search box — leave whatever location is already showing
    }
    await searchInput.fill(address);
    // Let the debounced suggestion fetch fully settle before interacting —
    // clicking mid-debounce risks landing on a suggestion list that's about
    // to be replaced by a fresher render.
    await this.page.waitForTimeout(1_500);

    // The suggestion dropdown sits two DOM levels above the input itself
    // (input -> wrapper -> results container holding the <ul><li> list) —
    // climbing from the input is what makes this resilient to the
    // suggestion list's build-hashed class names.
    let suggestion = searchInput.locator('xpath=../..').locator('li').first();
    if (!(await this.waitVisible(suggestion, 8_000))) {
      suggestion = this.page.locator('.pac-container .pac-item, ul[role="listbox"] li, .MuiAutocomplete-option').first();
    }

    if (await this.waitVisible(suggestion, 8_000)) {
      // Confirmed live: a plain click doesn't register here — something
      // (likely a transient backdrop from the sheet's own opening animation)
      // intercepts pointer events on the list right where the item renders,
      // so the click silently lands on nothing. `force: true` bypasses that
      // actionability check, matching the same workaround HomePage.ts uses
      // for overlay interference elsewhere in this app.
      await suggestion.click({ force: true });
    } else {
      await searchInput.press('ArrowDown').catch(() => undefined);
      await searchInput.press('Enter').catch(() => undefined);
    }

    const confirmButton = this.page.getByRole('button', { name: /confirm|continue/i }).first();
    if (await this.waitVisible(confirmButton, 10_000)) {
      await confirmButton.click();
      await this.page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Product catalog & cart
  // ─────────────────────────────────────────────────────────────────────

  /** Adds `count` distinct products from the catalog to the cart, verifying each add via the cart badge. */
  async selectRandomProducts(count = 2): Promise<SelectedProduct[]> {
    await this.waitForCatalogToLoad();

    const selections: SelectedProduct[] = [];
    const triedIndexes = new Set<number>();
    let cartCount = await this.readCartCount();

    for (let i = 0; i < count; i++) {
      const addButtons = await this.getCatalogAddButtons();
      if (!addButtons.length) {
        throw new Error('No add-to-cart buttons were visible on the menu.');
      }

      const candidateIndexes = addButtons.map((_, index) => index).filter((index) => !triedIndexes.has(index));
      const index = candidateIndexes[Math.floor(Math.random() * candidateIndexes.length)] ?? 0;
      triedIndexes.add(index);

      const button = addButtons[index];
      const card = await this.resolveProductCard(button);
      const productName = (await this.readProductName(card)) ?? `Product ${i + 1}`;
      const productPrice = (await this.readFirstVisibleText(card, ['text=/₹|rs\\.?\\s*\\d/i'])) ?? '';

      await button.scrollIntoViewIfNeeded();
      // Customizable products open a variant-picker dialog right on click. The
      // dialog's opening animation can cover the button before Playwright's
      // click finishes settling, which surfaces as a click timeout even though
      // the click itself landed — so a timeout here is not fatal on its own;
      // handleProductCustomizerIfPresent() below confirms what actually happened.
      await button.click().catch(() => undefined);
      const wentThroughOnboarding = await this.handleOrderTypeModalIfPresent();
      if (wentThroughOnboarding) {
        // Confirmed live: the first "Add" click on a fresh session is consumed
        // entirely by the order-type/delivery-address onboarding above — it
        // does not also add the item once onboarding finishes, so the same
        // button needs a second, now-unobstructed click.
        await button.click().catch(() => undefined);
      }
      await this.handleProductCustomizerIfPresent();

      const newCartCount = await this.pollUntilCartCountChanges(cartCount);
      if (newCartCount <= cartCount) {
        throw new Error(`Adding "${productName}" to the cart did not increase the cart count.`);
      }
      cartCount = newCartCount;

      selections.push({ name: productName, priceText: productPrice });
      console.log(`[cart] Added "${productName}" (${productPrice || 'price unknown'}) — cart now has ${cartCount} item(s).`);
    }

    return selections;
  }

  /** Returns visible "Add" buttons that belong to real product cards, skipping nav/search/footer chrome. */
  private async getCatalogAddButtons(): Promise<Locator[]> {
    const candidates = this.page.locator('button:has-text("Add")');
    const count = await candidates.count();

    const buttons: Locator[] = [];
    for (let i = 0; i < count; i++) {
      const button = candidates.nth(i);
      if (!(await button.isVisible())) continue;
      const card = await this.resolveProductCard(button);
      if (await this.looksLikeProductCard(card)) {
        buttons.push(button);
      }
    }
    return buttons;
  }

  /**
   * Walks up from an "Add" button, one parent at a time, until it finds an
   * ancestor whose text already looks like a single product card (name +
   * price). The immediate parent is usually just a thin wrapper around the
   * button itself, so a fixed ancestor depth is too fragile across product
   * types — but the climb is capped and sanity-checked so it can never grab
   * an oversized container (e.g. the whole catalog grid, or the page footer)
   * by mistake. If nothing matches within the cap, the immediate parent is
   * returned rather than an unvetted, overly broad ancestor.
   */
  private async resolveProductCard(addButton: Locator, maxDepth = 4): Promise<Locator> {
    const immediateParent = addButton.locator('xpath=..');
    let candidate = immediateParent;

    for (let depth = 0; depth < maxDepth; depth++) {
      candidate = candidate.locator('xpath=..');
      if (await this.looksLikeProductCard(candidate)) {
        return candidate;
      }
    }

    return immediateParent;
  }

  /**
   * A real single product card has a name and either a price or a
   * "quantity/serving" style description, and its text stays short — a
   * container that swallowed multiple cards (or unrelated page chrome like
   * the footer) will have far more text than a single card ever does.
   */
  private async looksLikeProductCard(card: Locator): Promise<boolean> {
    const rawText = (await card.textContent().catch(() => '')) ?? '';
    if (rawText.length > 250) return false; // too large to be a single card

    const text = normalizeText(rawText);
    if (!text) return false;
    if (/search products|type to search|continue shopping|payment methods|track order|select slot|clear cart|add delivery address|best in class/i.test(text)) {
      return false;
    }
    const hasPrice = /₹|rs\.?\s*\d/i.test(text);
    const hasServingInfo = /pcs|pot|bowl|plate|serves|gm|ml|kg/i.test(text);
    return hasPrice || hasServingInfo;
  }

  /**
   * Reads the product's display name from its card. Cards render several
   * `<p>` tags (a "60-90 mins"/"Slotted Delivery" badge, the name, the price),
   * so this skips paragraphs that look like a badge or price rather than
   * blindly taking the first one.
   */
  private async readProductName(card: Locator): Promise<string | null> {
    const paragraphs = card.locator('p');
    const count = await paragraphs.count().catch(() => 0);

    for (let i = 0; i < count; i++) {
      const paragraph = paragraphs.nth(i);
      if (!(await paragraph.isVisible().catch(() => false))) continue;

      const text = ((await paragraph.textContent().catch(() => '')) ?? '').trim();
      if (!text || /^\d+(\s*-\s*\d+)?\s*(pcs?|mins?)\b|slotted delivery|^₹|^rs\.?\s*\d/i.test(text)) continue;

      return text;
    }

    return this.readFirstVisibleText(card, ['h1', 'h2', 'h3', 'h4']);
  }

  /**
   * Handles the variant/quantity picker overlay some products open before
   * they can be added — it isn't a `role="dialog"` or MUI drawer, just a
   * plain overlay, so its presence is inferred from its own "Add Item"/"Add
   * to Cart" confirm button rather than a generic dialog container.
   *
   * The first variant (and any required "extra dip"-style option) already
   * comes pre-selected, so no explicit option picking is needed here.
   */
  /**
   * Clicking the header's address/delivery chip (in `setDeliveryLocationViaSearch`)
   * is what actually triggers a "How do you want your order?" Delivery/Takeaway
   * chooser, chained straight into a "Set delivery address" step and then a
   * map-based "Confirm & Continue" screen — confirmed live, even though the
   * header already shows a resolved address. It was first found blocking the
   * very first "Add" click of a fresh session (that click doesn't add the
   * tapped item once this onboarding finishes; it's just what happened to
   * trigger it that time), so this is also called opportunistically there as
   * a fallback. Returns whether any of it was shown, so callers that rely on
   * a click actually registering know to repeat it.
   */
  private async handleOrderTypeModalIfPresent(): Promise<boolean> {
    let handledSomething = false;

    const modalHeading = this.page.getByText(/how do you want your order/i).first();
    if (await this.waitVisible(modalHeading, 1_500)) {
      handledSomething = true;
      const deliveryOption = this.page.getByRole('button', { name: /delivery.*to your door/i }).first();
      if (await this.waitVisible(deliveryOption, 2_000)) {
        await deliveryOption.click();
      }
      await modalHeading.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
    }

    // Choosing "Delivery" above can chain straight into this second step even
    // though the header already shows a resolved address. Left unhandled, it
    // sits on top of the catalog the same way the first modal did.
    const addressHeading = this.page.getByText(/set delivery address/i).first();
    if (await this.waitVisible(addressHeading, 2_000)) {
      handledSomething = true;
      const useCurrentLocation = this.page.getByText(/use current location/i).first();
      if (await this.waitVisible(useCurrentLocation, 2_000)) {
        await useCurrentLocation.click();
      }
      await addressHeading.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);

      // "Use current location" resolves GPS to a pinned address on a map and
      // lands on a further "Confirm & Continue" screen — confirmed live, a
      // fully separate step from the "Set delivery address" one above.
      const confirmButton = this.page.getByRole('button', { name: /confirm\s*&?\s*continue/i }).first();
      if (await this.waitVisible(confirmButton, 10_000)) {
        await confirmButton.click();
        await confirmButton.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
      }
    }

    return handledSomething;
  }

  private async handleProductCustomizerIfPresent() {
    // The button's accessible name includes the price (e.g. "Add Item ₹629"),
    // so this matches on the leading label rather than the whole name.
    const confirmButton = this.page.getByRole('button', { name: /^add item|^add to cart/i }).first();
    if (!(await this.waitVisible(confirmButton, 1_000))) {
      return; // product was added directly, with no customizer overlay
    }

    await confirmButton.click();
    await confirmButton.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
  }

  private async readCartCount(): Promise<number> {
    const badge = this.page.locator('div:has(img[alt*="Cart"])').last();
    const text = (await badge.textContent().catch(() => '')) ?? '';
    const match = text.replace(/\s+/g, ' ').match(/\b(\d+)\b/);
    return match ? Number(match[1]) : 0;
  }

  /** Waits for the visible cart badge to reflect a new item, since add-to-cart has no dedicated "done" event. */
  private async pollUntilCartCountChanges(previousCount: number, timeoutMs = 8_000): Promise<number> {
    let latest = previousCount;
    await expect
      .poll(
        async () => {
          latest = await this.readCartCount();
          return latest;
        },
        { timeout: timeoutMs, message: 'Expected the cart count to increase after adding a product' }
      )
      .toBeGreaterThan(previousCount)
      .catch(() => undefined);
    return latest;
  }

  /**
   * Waits for real catalog data, not just skeleton placeholders — the loading
   * skeletons already render an "Add" button shape (with no price yet), so
   * waiting for that button alone is not enough to know the catalog is ready.
   *
   * The serviceability check behind this is occasionally flaky for a coordinate
   * that is, in fact, deliverable — a plain reload alone can just reload back
   * into the same not-deliverable state. Each retry instead reopens the header
   * location picker and switches to "Use Current Location" first, so it isn't
   * repeatedly hitting the exact same coordinate; falls back to a bare reload
   * if that control can't be found. Retries a few times before giving up.
   */
  private async waitForCatalogToLoad(maxAttempts = 5) {
    // Matches a non-zero price specifically — the persistent cart total badge
    // always renders "₹0" before anything is added, which would otherwise
    // satisfy a plain /₹\d/ check before the catalog has actually loaded.
    const priceText = this.page.locator('text=/₹[1-9]/').first();
    const notServiceableBanner = this.page.getByText(/we don.t deliver to this location yet/i).first();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await Promise.race([
        priceText.waitFor({ state: 'visible', timeout: 20_000 }),
        notServiceableBanner.waitFor({ state: 'visible', timeout: 20_000 }),
      ]).catch(() => undefined);

      if (await priceText.isVisible().catch(() => false)) {
        return;
      }

      if (attempt < maxAttempts) {
        console.warn(`[catalog] Location reported as not deliverable on attempt ${attempt}/${maxAttempts}; changing address to current location and retrying.`);
        const changedAddress = await this.changeAddressToCurrentLocation();
        if (!changedAddress) {
          await this.page.reload({ waitUntil: 'domcontentloaded' });
        }
        await this.dismissBlockingModal();
      }
    }

    throw new Error(`Catalog never loaded — location kept reporting as not deliverable after ${maxAttempts} attempts.`);
  }

  /**
   * Reopens the header's location picker via its "Change Address" control and
   * selects "Use Current Location" (relies on the geolocation permission
   * granted in playwright.config.ts). Returns whether it found the picker's
   * current-location control at all, so callers can fall back to a plain
   * reload when the header control isn't there to click.
   */
  private async changeAddressToCurrentLocation(): Promise<boolean> {
    const addressOpener = this.page
      .locator('[role="banner"], header')
      .first()
      .getByText(/india|bengaluru|karnataka|560\d{3}|delivery|change address/i)
      .first();
    if (await this.waitVisible(addressOpener, 5_000)) {
      await addressOpener.click().catch(() => undefined);
    }

    const currentLocationButton = this.page.getByRole('button', { name: /use current location/i }).first();
    if (!(await this.waitVisible(currentLocationButton, 5_000))) {
      return false;
    }
    await currentLocationButton.click();

    // Some entry points resolve and close the picker on their own once
    // geolocation settles; others show a confirm step first — handle both,
    // same pattern setDeliveryLocationViaSearch and saveNewCurrentLocationAddress use.
    const confirmButton = this.page.getByRole('button', { name: /confirm|continue|use this location/i }).first();
    if (await this.waitVisible(confirmButton, 10_000)) {
      await confirmButton.click();
    }

    await this.page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    return true;
  }

  /** Opens the cart, navigating directly to the route if the on-page trigger can't be found. */
  async openCart(maxAttempts = 5) {
    if (await this.isCartPageVisible()) return;

    // `div:has(img[alt*="Cart"]):has-text("₹")` matches every ancestor level
    // that wraps the cart-total widget, not just the widget itself — on this
    // deployment the outermost match spans wide enough to overlap the search
    // bar too, so `findVisible`'s implicit `.first()` grabs that oversized
    // wrapper and a click on it can land on the search box instead. `.last()`
    // resolves to the innermost (actual) widget — same fix readCartCount()
    // already uses below.
    const innermostCartWidget = this.page.locator('div:has(img[alt*="Cart"]):has-text("₹")').last();
    const cartTrigger = (await innermostCartWidget.isVisible().catch(() => false))
      ? innermostCartWidget
      : await this.findVisible(['a[href*="cart"]', 'button:has-text("Cart")']);
    if (cartTrigger) {
      await cartTrigger.click();
    }

    if (!(await this.isCartPageVisible())) {
      await this.page.goto('/cart', { waitUntil: 'domcontentloaded' });
    }

    const cartHeading = this.page.locator('text=/your cart/i').first();
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const loaded = await cartHeading.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);
      if (loaded) return;

      console.warn(`[cart] Cart page did not load in time on attempt ${attempt}/${maxAttempts}; reloading and retrying.`);
      await this.page.reload({ waitUntil: 'domcontentloaded' });
    }

    throw new Error(`Cart page never became visible after ${maxAttempts} attempts.`);
  }

  private async isCartPageVisible(): Promise<boolean> {
    if (/\/cart/i.test(this.page.url())) return true;
    return (await this.findVisible(['text=/your cart/i', 'text=/order summary/i'])) !== null;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Delivery slot
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Picks a delivery slot when the cart requires one; instant-delivery carts
   * need no action here.
   *
   * Confirmed live on this deployment (differs from dumdurrust.stage): the
   * "Schedule Delivery" drawer does *not* reliably open right after adding a
   * "Slotted Delivery" item or opening the cart — in several observed runs
   * it didn't appear at that point at all, and only surfaced later, when
   * `openMobileNumberEntry()` tries to proceed to login with a Slotted item
   * still lacking a set slot. So this method being a no-op here isn't proof
   * the cart doesn't need one — `dismissScheduleDeliveryDrawerIfOpen()` is
   * called again defensively at that later point too.
   */
  async selectDeliverySlotIfRequired() {
    await this.dismissScheduleDeliveryDrawerIfOpen();
  }

  /**
   * Picks the first available slot in the "Schedule Delivery" drawer if it's
   * currently open, and reports whether it found one to handle. Each slot is
   * its own button labelled with the time range itself (e.g. "6:30 pm – 7:30
   * pm") — there's no separate "Available" label like dumdurrust.stage has —
   * and clicking a slot closes the drawer immediately with no separate
   * confirm step (confirmed live).
   */
  private async dismissScheduleDeliveryDrawerIfOpen(timeoutMs = 3_000): Promise<boolean> {
    const drawer = this.page.locator('[role="dialog"], .MuiDrawer-root').filter({ hasText: /schedule.*delivery/i }).first();
    if (!(await this.waitVisible(drawer, timeoutMs))) {
      return false;
    }

    const slotOption = drawer.locator('button').filter({ hasText: /\d{1,2}:\d{2}\s*(am|pm)/i }).first();
    if (await this.waitVisible(slotOption, 5_000)) {
      await slotOption.click();
    }
    await drawer.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────
  // OTP login
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Logs in through the cart's OTP gate when one is shown. If OTP verification
   * is ever rejected, backs out to the mobile-number screen and tries again
   * with a fresh number, up to `maxLoginAttempts` times.
   */
  async ensureCartLoginCompleted(apiCalls: ApiCall[], uiAlerts: UiAlert[], maxLoginAttempts = 3): Promise<boolean> {
    if (!(await this.isLoginGateVisible())) {
      return false; // already logged in
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxLoginAttempts; attempt++) {
      try {
        await this.performOtpLogin(apiCalls, uiAlerts);
        await this.submitRegistrationIfShown(apiCalls);
        await this.returnToCartIfNeeded();

        const loggedIn = await this.confirmLoginSucceeded();
        if (!loggedIn) {
          throw new Error('Login could not be confirmed after OTP verification.');
        }
        return true;
      } catch (error) {
        lastError = error;
        console.warn(
          `[login] Attempt ${attempt}/${maxLoginAttempts} failed (${(error as Error).message}). ` +
            'Returning to the mobile number screen and trying again.'
        );
        if (attempt < maxLoginAttempts) {
          await this.returnToMobileNumberEntry();
        }
      }
    }

    throw new Error(`OTP login failed after ${maxLoginAttempts} attempts: ${(lastError as Error)?.message}`);
  }

  /** One full pass through the OTP screen: open the mobile-number screen, send a code, fill it in, verify. */
  private async performOtpLogin(apiCalls: ApiCall[], uiAlerts: UiAlert[]) {
    await this.openMobileNumberEntry();

    const mobileNumber = this.generateRandomMobileNumber();
    const mobileInput = this.page.locator('input[type="tel"], input[placeholder*="phone" i]').first();
    await mobileInput.waitFor({ state: 'visible', timeout: 15_000 });
    await mobileInput.fill(mobileNumber);

    // Confirmed live: a hidden "Continue as guest" icon button (its accessible
    // name comes from a `title` attribute, no visible text) sits earlier in
    // the DOM than the real "Send OTP" button and matches a bare /continue/i,
    // so `.first()` silently clicked that decoy instead — anchoring the
    // fallback alternatives to the *whole* accessible name (^...$) excludes
    // "Continue as guest" while still matching a plain "Continue"/"Login".
    const sendOtpButton = this.page.getByRole('button', { name: /send otp|^continue$|^login$/i }).first();
    const otpCall = await retryUntilApiSucceeds({
      apiCalls,
      label: 'Send OTP',
      matchesApi: (call) => /otp|auth|phone|login/i.test(call.url) && JSON.stringify(call.requestPayload ?? call.url).includes(mobileNumber.slice(-6)),
      action: async () => sendOtpButton.click(),
    });
    expectSuccessfulApiCall(otpCall, 'Send OTP');

    const otp = extractOtpFromResponse(otpCall);
    await this.fillOtpInputs(otp);

    const alertsBeforeVerify = uiAlerts.length;
    // Same decoy-button risk as sendOtpButton above — anchor the generic
    // fallbacks to the whole accessible name.
    const verifyButton = this.page.getByRole('button', { name: /verify|^continue$|^submit$/i }).first();
    const verifyCall = await retryUntilApiSucceeds({
      apiCalls,
      label: 'Verify OTP',
      matchesApi: (call) => /otp\/app\/verify|auth\/user\/login|customer\/v2\/get\/phone/i.test(call.url),
      action: async () => verifyButton.click(),
    });

    const rejectedByBackend = verifyCall.status >= 400 || /invalid otp|wrong otp|verification failed/i.test(JSON.stringify(verifyCall.responseBody ?? {}));
    const rejectedByUi = uiAlerts.slice(alertsBeforeVerify).some((alert) => /otp/i.test(alert.message) && alert.looksLikeError);
    if (rejectedByBackend || rejectedByUi) {
      throw new Error('OTP verification was rejected.');
    }

    const transitioned = await this.waitForPostOtpState();
    if (!transitioned) {
      throw new Error('App did not move past the OTP screen after verification.');
    }
  }

  private async fillOtpInputs(otp: string) {
    const inputs = this.page.locator('input[inputmode="numeric"], input[name*="otp" i]');
    const count = await inputs.count();

    if (count > 1) {
      for (let i = 0; i < Math.min(count, otp.length); i++) {
        await inputs.nth(i).fill(otp[i]);
      }
    } else {
      await inputs.first().fill(otp);
    }
  }

  /** Waits for the OTP screen to give way to registration, address entry, or the cart. */
  private async waitForPostOtpState(timeoutMs = 20_000): Promise<boolean> {
    const otpScreen = this.page.getByText(/enter otp/i).first();
    try {
      await expect(otpScreen).toBeHidden({ timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  /** Clicks whatever "back" control returns the OTP flow to the mobile-number screen. */
  private async returnToMobileNumberEntry() {
    const backControl = this.findVisible([
      'button[aria-label*="back" i]',
      'button:has-text("Change")',
      'button[aria-label*="close" i]',
    ]);
    const back = await backControl;
    if (back) {
      await back.click().catch(() => undefined);

      // Confirmed live: retrying from a registration failure (rather than an
      // OTP-verify failure) can match one of the selectors above to something
      // that doesn't actually navigate back — e.g. a leftover snackbar's
      // close button — leaving the next attempt's mobile-input wait to time
      // out on the same stuck screen. Verify the click actually landed
      // somewhere recoverable before trusting it.
      const mobileInputVisible = await this.waitVisible(
        this.page.locator('input[type="tel"], input[placeholder*="phone" i]').first(),
        5_000
      );
      if (mobileInputVisible || (await this.isLoginGateVisible())) {
        return;
      }
    }

    // No dedicated back control, or clicking it didn't actually land back on
    // the mobile-number screen — reloading the cart re-opens the login gate
    // fresh instead.
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await this.returnToCartIfNeeded();
  }

  /** Clicks past the "Almost There / Login or Signup" gate to reveal the mobile-number input. */
  private async openMobileNumberEntry() {
    await this.dismissScheduleDeliveryDrawerIfOpen();

    const mobileInputAlreadyVisible = await this.page.locator('input[type="tel"], input[placeholder*="phone" i]').first().isVisible().catch(() => false);
    if (mobileInputAlreadyVisible) return;

    const proceedButton = this.page.getByRole('button', { name: /proceed with phone number|send otp|login|sign in/i }).first();
    if (await this.waitVisible(proceedButton, 5_000)) {
      await proceedButton.click();
    }

    // Confirmed live: clicking "Proceed with phone number" can surface the
    // Schedule Delivery drawer instead of navigating to the login screen, if
    // a Slotted Delivery item's slot was never explicitly set. Pick a slot
    // and retry the same click once the drawer clears.
    if (await this.dismissScheduleDeliveryDrawerIfOpen()) {
      if (await this.waitVisible(proceedButton, 3_000)) {
        await proceedButton.click();
      }
    }
  }

  private async submitRegistrationIfShown(apiCalls: ApiCall[]) {
    const registerHeading = this.page.getByText(/create your account/i).first();
    if (!(await this.waitVisible(registerHeading, 3_000))) {
      return;
    }

    const nameInput = this.page.locator('input[name*="name" i], input[placeholder*="name" i]').first();
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.fill('Auto User');
    }

    const submitButton = this.page.getByRole('button', { name: /submit|create|register|continue/i }).first();
    await retryUntilApiSucceeds({
      apiCalls,
      label: 'Register account',
      matchesApi: (call) => /customer.*create|register/i.test(call.url),
      action: async () => submitButton.click(),
    });
    await expect(registerHeading).toBeHidden({ timeout: 15_000 });
  }

  private async returnToCartIfNeeded() {
    // A Razorpay session that 500s mid-flow (confirmed live: its own
    // account-validation call, not anything in this app) can leave its
    // checkout iframe open as an overlay on top of the cart — the URL still
    // reads /cart throughout, since it's an overlay, not a navigation, so
    // isCartPageVisible()'s URL check alone can't tell a stuck session apart
    // from a healthy cart. This is the escape hatch placeOrderAndPay's outer
    // retry relies on to recover from that: a visible Razorpay iframe forces
    // the hard reload regardless of what the URL says.
    const stuckRazorpayFrame = this.page.locator('iframe[src*="razorpay" i]').first();
    if (await stuckRazorpayFrame.isVisible().catch(() => false)) {
      await this.page.goto('/cart', { waitUntil: 'domcontentloaded' });
      return;
    }

    if (await this.isCartPageVisible()) return;
    await this.page.goto('/cart', { waitUntil: 'domcontentloaded' });
  }

  private async isLoginGateVisible(): Promise<boolean> {
    return (
      (await this.findVisible([
        'button:has-text("Send OTP")',
        'text=/proceed with phone number/i',
        'text=/login or signup to place your order/i',
      ])) !== null
    );
  }

  private async confirmLoginSucceeded(timeoutMs = 15_000): Promise<boolean> {
    try {
      await expect
        .poll(async () => (await this.isLoginGateVisible()) === false, {
          timeout: timeoutMs,
          message: 'Expected the login gate to disappear after OTP verification',
        })
        .toBe(true);
      return true;
    } catch {
      return false;
    }
  }

  private generateRandomMobileNumber(): string {
    const suffix = `${Math.floor(Math.random() * 100_000_000)}`.padStart(8, '0');
    return `9${suffix}1`;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Delivery address
  // ─────────────────────────────────────────────────────────────────────

  /** Attaches a delivery address to the cart, reusing a saved one if available, otherwise saving a new one. */
  async ensureDeliveryAddressAttached(apiCalls: ApiCall[]): Promise<string> {
    await this.openAddressEntrySurface();

    const reusedAddress = await this.selectSavedAddressIfAvailable();
    const addressText = reusedAddress ?? (await this.saveNewCurrentLocationAddress(apiCalls));

    await this.waitForCartWithAddressAttached();
    return addressText;
  }

  /**
   * After saving/selecting an address the app itself marks it as the default
   * and redirects back to the cart, but only once the backend write lands —
   * forcing an immediate goto('/cart') races that and can load a cart the
   * address isn't attached to yet. Give the app a generous window to navigate
   * on its own, fall back to a manual goto only if it never does, then wait
   * for the "Add Delivery Address" CTA to clear (it can flash briefly while
   * the cart's own state catches up).
   */
  private async waitForCartWithAddressAttached() {
    let reachedCartOnItsOwn = true;
    try {
      await expect
        .poll(async () => this.isCartPageVisible(), {
          timeout: 20_000,
          message: 'Expected the app to return to the cart on its own after attaching an address',
        })
        .toBe(true);
    } catch {
      reachedCartOnItsOwn = false;
    }

    if (!reachedCartOnItsOwn) {
      await this.page.goto('/cart', { waitUntil: 'domcontentloaded' });
    }

    // Soft wait: if the CTA genuinely never clears, the re-attach loop in
    // ensureAddressStaysAttachedForCheckout is the recovery path, not a throw here.
    const addAddressButton = this.page.getByRole('button', { name: /add delivery address/i }).first();
    await expect(addAddressButton).toBeHidden({ timeout: 15_000 }).catch(() => undefined);
  }

  private async openAddressEntrySurface() {
    if (/\/address-book/i.test(this.page.url())) return;

    const addAddressButton = this.page.getByRole('button', { name: /add delivery address|add address|change address/i }).first();
    if (await addAddressButton.isVisible().catch(() => false)) {
      await addAddressButton.click();
    } else {
      await this.page.goto('/address-book', { waitUntil: 'domcontentloaded' });
    }

    await this.page
      .locator('button:has-text("Current Location"), button:has-text("Add New Address"), input[name*="building" i]')
      .first()
      .waitFor({ state: 'visible', timeout: 15_000 });
  }

  /**
   * Picks a saved address card if one already exists, so the flow reuses it
   * instead of trying to create a duplicate (the backend rejects a second
   * address of the same type with "Address with same type exists").
   *
   * Matches primarily by the exact building name this flow always saves new
   * addresses under — a precise, unambiguous match — falling back to a
   * generic "Home"/"Work"/"Other" heading in case that text isn't visible
   * (e.g. truncated in a narrower card layout).
   */
  private async selectSavedAddressIfAvailable(): Promise<string | null> {
    const byBuildingName = this.page.getByText(NEW_ADDRESS_DETAILS.buildingName, { exact: false }).first();
    const byAddressTypeHeading = this.page
      .locator('h3, [role="heading"]')
      .filter({ hasText: /^(home|work|other)$/i })
      .first();

    const matchedLabel = (await this.waitVisible(byBuildingName, 3_000))
      ? byBuildingName
      : (await this.waitVisible(byAddressTypeHeading, 3_000))
        ? byAddressTypeHeading
        : null;

    if (!matchedLabel) {
      const bodyText = await this.page.locator('body').innerText().catch(() => '');
      console.log(`[debug] selectSavedAddressIfAvailable: no card matched. url=${this.page.url()}\n---BODY TEXT---\n${bodyText.slice(0, 3000)}\n---END---`);
      return null;
    }

    const addressCard = matchedLabel.locator('xpath=ancestor::*[self::div or self::article][1]');
    const addressText = normalizeText(((await addressCard.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim());
    await addressCard.click();
    // Give the backend a moment to actually record the selection before the
    // caller checks the cart again — checking immediately can observe stale
    // state and re-click the same card in a loop without it ever landing.
    await this.page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    return addressText || null;
  }

  /** Runs the "use current location → confirm on map → fill details → save" flow for a brand-new address. */
  private async saveNewCurrentLocationAddress(apiCalls: ApiCall[]): Promise<string> {
    const addNewButton = this.page.getByRole('button', { name: /add new address/i }).first();
    if (await addNewButton.isVisible().catch(() => false)) {
      await addNewButton.click();
    }

    // Geolocation is granted via playwright.config.ts. Some entry points land
    // straight on the resolved-location map (no separate button to press);
    // others show an explicit "Current Location" button first — handle both.
    const currentLocationButton = this.page.getByRole('button', { name: /current location/i }).first();
    if (await this.waitVisible(currentLocationButton, 5_000)) {
      await currentLocationButton.click();
    }

    const confirmLocationButton = this.page.getByRole('button', { name: /confirm|use this location|enter complete details/i }).first();
    await confirmLocationButton.waitFor({ state: 'visible', timeout: 20_000 });
    await confirmLocationButton.click();

    const buildingInput = this.page.locator('input[name*="building" i], input[placeholder*="house" i], input[placeholder*="flat" i]').first();
    await buildingInput.waitFor({ state: 'visible', timeout: 15_000 });
    await buildingInput.fill(NEW_ADDRESS_DETAILS.buildingName);

    const landmarkInput = this.page.locator('input[name*="landmark" i], input[placeholder*="landmark" i]').first();
    if (await landmarkInput.isVisible().catch(() => false)) {
      await landmarkInput.fill(NEW_ADDRESS_DETAILS.landmark);
    }

    const typeControl = this.page.getByText(new RegExp(`^${NEW_ADDRESS_DETAILS.addressType}$`, 'i')).first();
    if (await typeControl.isVisible().catch(() => false)) {
      await typeControl.click();
    }

    const saveButton = this.page.getByRole('button', { name: /add address|save address|deliver here|save & proceed/i }).first();
    const addressCall = await retryUntilApiSucceeds({
      apiCalls,
      label: 'Save delivery address',
      matchesApi: (call) => /address\/v1\/create/i.test(call.url),
      action: async () => saveButton.click(),
    });
    expectSuccessfulApiCall(addressCall, 'Save delivery address');

    return normalizeText(this.buildAddressText(addressCall.responseBody) || NEW_ADDRESS_DETAILS.buildingName);
  }

  /**
   * The cart's "Add Delivery Address" CTA can reappear even after an address
   * was already attached — a background cart refresh occasionally drops the
   * link moments later, so a single re-check isn't enough to trust. Polls for
   * up to `timeoutMs`, re-attaching an address (reusing a saved one, or
   * creating a fresh one if none is reusable yet) any time the CTA reverts,
   * until "Place Order" is showing and stays showing.
   */
  private async ensureAddressStaysAttachedForCheckout(apiCalls: ApiCall[], timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    let reattachCount = 0;

    while (Date.now() < deadline) {
      const placeOrderVisible = await this.page.getByRole('button', { name: /place order/i }).first().isVisible().catch(() => false);
      if (placeOrderVisible) return;

      const addAddressButton = this.page.getByRole('button', { name: /add delivery address/i }).first();
      if (!(await addAddressButton.isVisible().catch(() => false))) {
        return; // something other than the address is blocking checkout — let the caller's own wait surface it
      }

      reattachCount += 1;
      console.warn(`[checkout] Cart lost its attached delivery address (re-attach #${reattachCount}); re-attaching one.`);
      await this.ensureDeliveryAddressAttached(apiCalls);
    }
  }

  private buildAddressText(source: unknown): string {
    const parts = this.collectAddressParts(source);
    return [...new Set(parts.map((part) => part.trim()).filter(Boolean))].join(', ');
  }

  private collectAddressParts(value: unknown): string[] {
    if (!value || typeof value !== 'object') return [];
    const addressKeys = ['addressLine1', 'addressLine2', 'streetAddress', 'street_address', 'flatHouseBuilding', 'landmark', 'city', 'state', 'pinCode', 'pincode', 'country'];
    const parts: string[] = [];
    for (const [key, nested] of Object.entries(value)) {
      if (typeof nested === 'string' && addressKeys.includes(key) && nested.trim()) {
        parts.push(nested);
      } else if (nested && typeof nested === 'object') {
        parts.push(...this.collectAddressParts(nested));
      }
    }
    return parts;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Payment & order placement
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Places the order and pays through the Razorpay sandbox, returning details
   * read from the order API. The delivery slot is expected to already be
   * selected (via `selectDeliverySlotIfRequired`) — the cart's "Select Slot"
   * link stays present as a "change slot" affordance even after a slot is
   * picked, so calling it again here would reopen the drawer unnecessarily
   * and can knock the attached delivery address back out.
   */
  async placeOrderAndPay(apiCalls: ApiCall[]): Promise<OrderSummary> {
    const callCountBeforePlaceOrder = apiCalls.length;

    // The payment step has failed in several unrelated ways across live runs
    // — the Razorpay iframe not opening at all, or opening but never
    // reaching a confirmed order — that all trace back to backend/gateway
    // flakiness rather than anything actionable in the UI. Retrying only
    // inside one already-broken checkout session isn't enough when the
    // flakiness affects that whole session, so this outer retry restarts the
    // entire "place order → pay" sequence from scratch on failure: a fresh
    // order-create call and a fresh Razorpay session, not just another pass
    // over an iframe that may already be stuck. `returnToCartIfNeeded()`'s
    // hard `goto('/cart')` fallback (used when we're not already showing the
    // cart) doubles as the escape hatch out of a stuck Razorpay iframe here.
    await expect(async () => {
      await this.returnToCartIfNeeded();

      const placeOrderButton = this.page.getByRole('button', { name: /place order/i }).first();

      // The address can drop off the cart again in the moment right before
      // this click, so re-check immediately before clicking rather than
      // trusting an earlier check — retrying the whole "confirm attached,
      // then click" pair handles that race instead of just the confirmation
      // step alone.
      await expect(async () => {
        await this.ensureAddressStaysAttachedForCheckout(apiCalls);
        await placeOrderButton.click({ timeout: 5_000 });
      }).toPass({ timeout: 60_000 });

      const paymentFrame = await this.openRazorpayCheckout(apiCalls);

      // The Razorpay sandbox itself can occasionally 500 mid-flow (seen on
      // its own account-validation call) while leaving its iframe open on
      // the same payment-options screen rather than closing the checkout
      // session — confirmed live that once that iframe is open, re-clicking
      // "Pay Online" on a retry is both unnecessary and impossible (the
      // iframe now covers that row), so only the click-through *inside* the
      // already-open iframe gets retried here, not the whole open-checkout
      // step above.
      //
      // Confirmed live that a legitimate "Confirming Payment — this will
      // only take a few seconds" step can outlast a single wait window on
      // its own — re-running the click-through in that state (rather than
      // just waiting longer) re-clicks "Continue" with nothing selected and
      // produces a *self-inflicted* "Please select one of these options"
      // error. Only re-click when we're actually still on the
      // payment-selection screen.
      await expect(async () => {
        // A real wait, not an instant check — right after the iframe first
        // opens, its own "Payment Options" content can still be rendering
        // (~5s from frame attach, confirmed from a run's network log), and
        // an instant check here can miss it and skip the click-through
        // entirely on the first attempt.
        //
        // Confirmed live (via a frame body-text dump on a run that otherwise
        // timed out here): this checkout build no longer marks the "Payment
        // Options" title with an ARIA heading role at all, so a `getByRole`
        // heading match silently never fires even while "Payment Options /
        // UPI / Cards / EMI / Netbanking / ..." is genuinely showing —
        // filtering a plain text match down to visible elements is what
        // actually holds up across builds (the same pattern already used for
        // the UPI/PhonePe row below, for the same "hidden duplicate" reason).
        const stillSelectingPaymentMethod = await this.waitVisible(
          paymentFrame.getByText('Payment Options', { exact: true }).filter({ visible: true }).first(),
          10_000
        );
        if (stillSelectingPaymentMethod) {
          await this.completeRazorpaySandboxPayment(paymentFrame);
        }
        await this.page
          .locator('text=/order confirmed|order placed successfully|thank you|track order/i')
          .first()
          .waitFor({ state: 'visible', timeout: 30_000 });
      }).toPass({ timeout: 60_000 });
    }).toPass({ timeout: 180_000 });

    const orderCall =
      apiCalls
        .slice(callCountBeforePlaceOrder)
        .find((call) => /order/i.test(call.url) && call.status < 400 && /success|created|placed|confirmed/i.test(JSON.stringify(call.responseBody ?? {}))) ??
      findLatestApiCall(apiCalls, (call) => /order|payment/i.test(call.url) && call.status < 400);

    if (!orderCall) {
      throw new Error('Unable to find a successful order/payment API call after placing the order.');
    }
    expectSuccessfulApiCall(orderCall, 'Order placement');

    return {
      orderId: this.extractFieldValue(orderCall.responseBody, ['orderId', 'id']),
      orderNumber: findTextInObject(orderCall.responseBody, [/order[-_\s]?number/i]) ?? this.extractFieldValue(orderCall.responseBody, ['orderNumber', 'displayOrderId']),
      paymentMethod: findTextInObject(orderCall.responseBody, [/upi/i, /online/i, /prepaid/i]) ?? 'ONLINE',
      status: findTextInObject(orderCall.responseBody, [/created/i, /ordered/i, /success/i]) ?? 'CREATED',
      addressText: this.buildAddressText(orderCall.responseBody),
    };
  }

  /** Waits for the Razorpay iframe after "Place Order", clicking through an intermediate Pay Online screen only if one appears. */
  private async openRazorpayCheckout(apiCalls: ApiCall[]): Promise<FrameLocator> {
    // Confirmed from a failed run's trace (network log, not speculation):
    // on this deployment clicking "Place Order" itself creates the order
    // (POST /proxy/cart/v2/b2c/create/order, 200) and launches the Razorpay
    // iframe directly ~1s later — there is no intermediate "Payment Methods"
    // screen with a "Pay Online" row the way dumdurrust.stage has. Waiting
    // for that screen here is exactly what used to sink every payment
    // attempt: the wait timed out ~15s after a perfectly healthy checkout
    // had already opened, and the outer retry then reloaded /cart and tore
    // the session down, over and over. (The validate/account 500 logged just
    // after each checkout opens is unrelated background noise — Razorpay
    // fires it automatically on load to probe the prefilled phone number as
    // a UPI "VPA", before the test has touched the iframe at all.)
    const paymentFrame = await this.waitForRazorpayFrame(20_000);
    if (paymentFrame) {
      return paymentFrame;
    }

    // Fallback for a dumdurrust.stage-style intermediate screen, where order
    // creation only happens once "Pay Online" is clicked. That click's order
    // creation can hang or get reset on a cold backend — on failure the app
    // just shows an "Order creation failed" snackbar and leaves the Pay
    // Online row clickable in place, so a plain re-click (no reload/dismiss)
    // is enough.
    await retryUntilApiSucceeds({
      apiCalls,
      label: 'Create order',
      matchesApi: (call) => /create\/order/i.test(call.url),
      perAttemptTimeoutMs: 20_000,
      action: async () => {
        // Click the row's own text rather than a `div:has-text(...)` container —
        // that broad a selector can resolve to a large ancestor wrapping the
        // whole page, whose center point is nowhere near the actual clickable row.
        const payOnlineRow = this.page.getByText('Pay Online', { exact: true }).first();
        await payOnlineRow.waitFor({ state: 'visible', timeout: 15_000 });
        await payOnlineRow.click();
      },
    });

    const fallbackFrame = await this.waitForRazorpayFrame();
    if (!fallbackFrame) {
      throw new Error('Razorpay iframe did not open after placing the order.');
    }
    return fallbackFrame;
  }

  /** Runs the sandbox UPI click-through inside an already-open Razorpay iframe. */
  private async completeRazorpaySandboxPayment(paymentFrame: FrameLocator) {
    // Confirmed live: clicking "UPI - PhonePe" alone simulates a successful
    // payment within ~2s — no "Continue" or success-confirmation click
    // needed. "UPI - Google Pay" doesn't behave the same way in this sandbox
    // (it tries a real gpay:// intent, which can't resolve here), so PhonePe
    // must be tried first, not just "any recommended app". The account-
    // validation 500 the app occasionally logs around this point is a
    // harmless background failure — it fires even on runs that go on to
    // confirm the order, so it isn't actually the blocker it looks like.
    // Filter every text match down to visible elements before taking
    // .first() — this checkout build renders hidden duplicates of visible
    // labels (confirmed from a failed run's trace, where the "Payment
    // Options" title text resolved to a hidden span), and a hidden first
    // match makes both the visibility check and the click silently target
    // the wrong element.
    const phonePe = paymentFrame.getByText('UPI - PhonePe', { exact: true }).filter({ visible: true }).first();
    if (await this.waitVisible(phonePe, 5_000)) {
      await phonePe.click();
      return;
    }

    // PhonePe isn't always offered — Razorpay can instead render a QR-only
    // UPI view (a scannable code plus non-actionable app icons, no clickable
    // "recommended app" row) with no automatable success path at all.
    // Netbanking → Bank of Baroda is a stable fallback present in every
    // checkout variant, ending in the sandbox's own simulated bank page.
    await this.completeNetbankingFallback(paymentFrame);
  }

  /** Falls back to Netbanking → Bank of Baroda when no UPI recommended-app row is offered, then clicks the sandbox's simulated bank "Success" button. */
  private async completeNetbankingFallback(paymentFrame: FrameLocator) {
    const netbanking = paymentFrame.getByText(/^netbanking$/i).filter({ visible: true }).first();
    if (await this.waitVisible(netbanking, 5_000)) {
      // Confirmed live: a plain click here misses — a decorative background
      // SVG and an overlay-backdrop div both intercept pointer events right
      // where this category label renders, the same kind of overlay
      // interference `force: true` already works around elsewhere in this
      // file (see setDeliveryLocationViaSearch's suggestion click).
      await netbanking.click({ force: true });
    }

    const bankOfBaroda = paymentFrame.getByText(/bank of baroda/i).filter({ visible: true }).first();
    if (!(await this.waitVisible(bankOfBaroda, 8_000))) {
      return;
    }

    // Confirmed live via screenshot: selecting the bank opens Razorpay's
    // simulated bank-auth page ("Welcome to Razorpay Software Private Ltd
    // Bank" with Success/Failure buttons) in a brand-new browser window/tab —
    // not inside this iframe and not on the top-level page — so the popup
    // has to be captured at the same time as the click that triggers it.
    const [popup] = await Promise.all([
      this.page.context().waitForEvent('page', { timeout: 20_000 }).catch(() => null),
      bankOfBaroda.click({ force: true }),
    ]);

    if (popup) {
      await popup.waitForLoadState('domcontentloaded').catch(() => undefined);
      const successButton = popup.getByRole('button', { name: /success/i }).first();
      if (await this.waitVisible(successButton, 15_000)) {
        await successButton.click();
      }
      return;
    }

    // No popup appeared — fall back to the possibility that this deployment
    // instead renders the bank confirmation in-frame or on the top-level page.
    const proceedButton = paymentFrame.getByRole('button', { name: /pay|continue|proceed/i }).first();
    if (await this.waitVisible(proceedButton, 5_000)) {
      await proceedButton.click();
    }

    const successInFrame = paymentFrame.getByRole('button', { name: /success/i }).first();
    const successOnPage = this.page.getByRole('button', { name: /success/i }).first();
    if (await this.waitVisible(successInFrame, 15_000)) {
      await successInFrame.click();
    } else if (await this.waitVisible(successOnPage, 15_000)) {
      await successOnPage.click();
    }
  }

  private async waitForRazorpayFrame(timeoutMs = 15_000): Promise<FrameLocator | null> {
    try {
      await expect
        .poll(() => this.page.frames().some((frame) => /razorpay/i.test(frame.url())), {
          timeout: timeoutMs,
          message: 'Expected the Razorpay iframe to load after clicking Pay Online',
        })
        .toBe(true);
      // Scope specifically to the Razorpay iframe by its src, not just
      // "whatever iframe is last in the DOM" — this app also uses hCaptcha
      // elsewhere (its own iframe), and if that one ends up last, every
      // action here would silently target the wrong frame while the real
      // Razorpay UI sits untouched.
      return this.page.frameLocator('iframe[src*="razorpay" i]').last();
    } catch {
      return null;
    }
  }

  private extractFieldValue(value: unknown, keys: string[]): string {
    if (!value || typeof value !== 'object') return '';
    for (const [key, nested] of Object.entries(value)) {
      if (keys.includes(key) && (typeof nested === 'string' || typeof nested === 'number')) {
        return String(nested);
      }
    }
    for (const nested of Object.values(value)) {
      if (nested && typeof nested === 'object') {
        const found = this.extractFieldValue(nested, keys);
        if (found) return found;
      }
    }
    return '';
  }

  // ─────────────────────────────────────────────────────────────────────
  // Shared low-level helpers
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Closes a first-load "enter your phone number" or similar interstitial
   * modal, if one is present. This is a race, not a certainty — the app only
   * shows it occasionally (seen live: roughly 1 in 20 loads), likely when
   * geolocation resolution hasn't completed yet — so the close button is
   * often an icon with no accessible name, and a single narrow selector
   * attempt isn't reliable. Try progressively broader techniques rather than
   * giving up after the first miss.
   */
  private async dismissBlockingModal() {
    const namedCloseButton = await this.findVisible(['button[aria-label*="close" i]', 'button:has-text("×")', 'button:has-text("Skip")']);
    if (namedCloseButton) {
      await namedCloseButton.click().catch(() => undefined);
      return;
    }

    const welcomeModal = this.page.getByText(/enter your phone number to continue/i).first();
    if (!(await this.waitVisible(welcomeModal, 2_000))) {
      return; // no blocking modal this load
    }

    await this.page.keyboard.press('Escape').catch(() => undefined);
    if (!(await welcomeModal.isVisible().catch(() => false))) {
      return;
    }

    const iconCloseButton = this.page.locator('button:has(svg), button:has(img)').first();
    if (await this.waitVisible(iconCloseButton, 2_000)) {
      await iconCloseButton.click({ force: true }).catch(() => undefined);
      if (!(await welcomeModal.isVisible().catch(() => false))) {
        return;
      }
    }

    // Last resort: from a captured screenshot, the close control renders as
    // a circular icon near the modal's top-right corner — try that position
    // directly in case no selector above matched it.
    const viewport = this.page.viewportSize();
    if (viewport) {
      await this.page.mouse.click(viewport.width - 55, 65).catch(() => undefined);
    }
  }

  private async readFirstVisibleText(root: Locator, selectors: string[]): Promise<string | null> {
    for (const selector of selectors) {
      const locator = root.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        if (selector.startsWith('img')) {
          const alt = (await locator.getAttribute('alt').catch(() => '')) ?? '';
          if (alt.trim()) return alt.trim();
          continue;
        }
        const text = ((await locator.textContent().catch(() => '')) ?? '').trim();
        if (text) return text;
      }
    }
    return null;
  }

  private async findVisible(selectors: string[]): Promise<Locator | null> {
    for (const selector of selectors) {
      const locator = this.page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }
    return null;
  }

  /**
   * Waits up to `timeoutMs` for `locator` to become visible, returning
   * whether it did — unlike `Locator.isVisible({ timeout })`, whose
   * `timeout` option is deprecated and silently ignored (it always checks
   * instantly, never waits). That footgun previously caused a real bug here:
   * a check right after a reload ran before the SPA had re-rendered, saw
   * nothing, and skipped a click it should have made. Use this wherever a
   * genuine "give it a moment to appear" check is intended.
   */
  private async waitVisible(locator: Locator, timeoutMs: number): Promise<boolean> {
    return locator
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(() => true)
      .catch(() => false);
  }
}
