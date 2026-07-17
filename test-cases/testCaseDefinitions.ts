export type TestSuite = 'Sanity' | 'End to End' | 'API Testing';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

export interface TestCaseDefinition {
  id: string;
  suite: TestSuite;
  module: string;
  title: string;
  priority: Priority;
  expectedResult: string;
}

/**
 * Single source of truth for every functional test case — the static
 * columns (Module, Priority, Expected Result) live here, not duplicated in
 * each spec file. Each spec imports the entry it implements and uses
 * `tc.title` for the test title and `@${tc.id}` as the test's tag, so the
 * spreadsheet (scripts/generate-test-case-report.ts) and the actual
 * Playwright test can never drift apart.
 */
export const TEST_CASES: TestCaseDefinition[] = [
  // ── Sanity ─────────────────────────────────────────────────────────────
  {
    id: 'SAN-001',
    suite: 'Sanity',
    module: 'Homepage',
    title: 'Homepage loads without hard console/UI errors',
    priority: 'P0',
    expectedResult: 'The homepage renders (header, catalog, footer) and no hard (non-benign) console or page error is logged.',
  },
  {
    id: 'SAN-002',
    suite: 'Sanity',
    module: 'Catalog',
    title: 'Catalog renders products with valid prices',
    priority: 'P0',
    expectedResult: 'At least one product card is visible with a non-zero, correctly formatted price (₹ prefix).',
  },
  {
    id: 'SAN-003',
    suite: 'Sanity',
    module: 'Cart',
    title: 'Adding a product increases the cart count',
    priority: 'P0',
    expectedResult: 'Clicking "Add" on a product increases the visible cart badge count by one.',
  },
  {
    id: 'SAN-004',
    suite: 'Sanity',
    module: 'Cart',
    title: 'Cart opens and shows the added product',
    priority: 'P0',
    expectedResult: 'Opening the cart displays the previously added product by name.',
  },
  {
    id: 'SAN-005',
    suite: 'Sanity',
    module: 'Onboarding',
    title: 'Delivery/Takeaway order-type onboarding can be completed',
    priority: 'P0',
    expectedResult: 'If the "How do you want your order?" modal (and any chained address-setup step) appears, it can be completed by selecting Delivery, and the catalog remains usable afterward.',
  },
  {
    id: 'SAN-006',
    suite: 'Sanity',
    module: 'Order Placement',
    title: 'A single product can be ordered and paid for end-to-end',
    priority: 'P0',
    expectedResult: 'Browsing, adding one product, logging in via OTP, attaching a delivery address, and paying through the Razorpay sandbox results in a confirmed order with a valid order id/number.',
  },

  // ── End to End ─────────────────────────────────────────────────────────
  {
    id: 'E2E-001',
    suite: 'End to End',
    module: 'Order Placement',
    title: 'Single-product order placement returns full confirmation details',
    priority: 'P0',
    expectedResult: 'The completed order returns a non-empty order id or number and a recognized payment method (e.g. ONLINE).',
  },
  {
    id: 'E2E-002',
    suite: 'End to End',
    module: 'Cart',
    title: 'Multi-product order placement completes successfully',
    priority: 'P1',
    expectedResult: 'Adding 2 distinct products and completing checkout results in a confirmed order reflecting both products were part of the cart.',
  },
  {
    id: 'E2E-003',
    suite: 'End to End',
    module: 'Delivery Slot',
    title: 'Delivery-slot selection (when presented) does not block order placement',
    priority: 'P2',
    expectedResult: 'If a delivery-slot drawer is shown, a slot is selected and checkout proceeds; if not shown, checkout proceeds normally either way — the order is confirmed.',
  },
  {
    id: 'E2E-004',
    suite: 'End to End',
    module: 'Stability',
    title: 'No hard UI/console errors occur across a complete order journey',
    priority: 'P0',
    expectedResult: 'Zero non-benign "hard" console/page errors are logged from homepage through order confirmation.',
  },
  {
    id: 'E2E-005',
    suite: 'End to End',
    module: 'Onboarding',
    title: 'Order-type onboarding consuming the first Add click does not lose that product',
    priority: 'P1',
    expectedResult: 'When the first "Add" click triggers the Delivery/Takeaway + address onboarding chain instead of adding the item, the product is still added to the cart once onboarding completes (regression test for the PlaceOrderPage.handleOrderTypeModalIfPresent fix).',
  },
  {
    id: 'E2E-006',
    suite: 'End to End',
    module: 'Payment',
    title: 'Order completes regardless of which Razorpay payment view is presented',
    priority: 'P1',
    expectedResult: 'Whether the sandbox shows a UPI recommended-app row or falls back to Netbanking/Bank of Baroda, the payment completes and the order is confirmed.',
  },

  // ── API Testing ────────────────────────────────────────────────────────
  {
    id: 'API-001',
    suite: 'API Testing',
    module: 'Authentication',
    title: 'Send-OTP request succeeds and returns a valid OTP',
    priority: 'P0',
    expectedResult: 'The send-OTP API call responds with a status under 400, and the response body contains an extractable OTP value.',
  },
  {
    id: 'API-002',
    suite: 'API Testing',
    module: 'Authentication',
    title: 'Verify-OTP request succeeds and reflects a logged-in state',
    priority: 'P0',
    expectedResult: 'The verify-OTP API call responds with a status under 400 and the app transitions past the OTP screen.',
  },
  {
    id: 'API-003',
    suite: 'API Testing',
    module: 'Address',
    title: 'Save-address request succeeds and echoes the submitted address',
    priority: 'P0',
    expectedResult: 'The address-save API call responds with a status under 400 and the cart reflects a non-empty delivery address afterward.',
  },
  {
    id: 'API-004',
    suite: 'API Testing',
    module: 'Order',
    title: 'Create-order request succeeds and returns an order id/number',
    priority: 'P0',
    expectedResult: 'The order-creation API call (surfaced through placeOrderAndPay) responds with a status under 400 and a non-empty order id or number.',
  },
  {
    id: 'API-005',
    suite: 'API Testing',
    module: 'Reliability',
    title: 'No non-benign failed API calls occur across a full order journey',
    priority: 'P1',
    expectedResult: 'Every API call observed from homepage through order confirmation returns a status under 400, except third-party calls already allow-listed as benign (Razorpay/hCaptcha/Sardine).',
  },
];

export function getTestCase(id: string): TestCaseDefinition {
  const tc = TEST_CASES.find((t) => t.id === id);
  if (!tc) {
    throw new Error(`No test case definition found for id "${id}" — check test-cases/testCaseDefinitions.ts`);
  }
  return tc;
}
