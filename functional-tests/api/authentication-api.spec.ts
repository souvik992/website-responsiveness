import { test, expect } from '../../fixtures/errorMonitor';
import { PlaceOrderPage } from '../../pages/PlaceOrderPage';
import { expectSuccessfulApiCall, extractOtpFromResponse } from '../../utils/orderFlowAssertions';
import { getTestCase } from '../../test-cases/testCaseDefinitions';

// Same endpoint patterns PlaceOrderPage.performOtpLogin uses internally
// (pages/PlaceOrderPage.ts:629, 644) — these tests assert on the same
// `apiCalls` array that fixture already captures passively, rather than
// duplicating the page object's own retry/matching logic.
const SEND_OTP_PATTERN = /otp|auth|phone|login/i;
const VERIFY_OTP_PATTERN = /otp\/app\/verify|auth\/user\/login|customer\/v2\/get\/phone/i;

test.describe('API Testing — Authentication', () => {
  // OTP login includes its own internal retry loop against a staging backend
  // that's occasionally slow to respond — matches the generous budget used
  // elsewhere in this suite rather than risking a false failure on a tight one.
  test.setTimeout(7 * 60_000);

  const apiSendOtp = getTestCase('API-001');
  test(apiSendOtp.title, { tag: `@${apiSendOtp.id}` }, async ({ page, apiCalls, uiAlerts }) => {
    const placeOrderPage = new PlaceOrderPage(page);

    await placeOrderPage.goto();
    await placeOrderPage.waitForReady();
    await placeOrderPage.selectRandomProducts(1);
    await placeOrderPage.openCart();
    await placeOrderPage.ensureCartLoginCompleted(apiCalls, uiAlerts);

    // The broad SEND_OTP_PATTERN alone is ambiguous — confirmed live it can
    // also match an unrelated auth/token call that happens to contain
    // "auth"/"login" in its URL. PlaceOrderPage disambiguates internally by
    // also requiring the generated phone number's last 6 digits in the
    // payload, which isn't available here — so instead, take whichever
    // candidate call actually contains an extractable OTP, which is the
    // real signal this test cares about.
    const candidates = apiCalls.filter((call) => SEND_OTP_PATTERN.test(call.url));
    expect(candidates.length, 'Expected at least one send-OTP-like API call to have been captured').toBeGreaterThan(0);

    let otp: string | undefined;
    let sendOtpCall: (typeof candidates)[number] | undefined;
    for (const call of candidates) {
      try {
        otp = extractOtpFromResponse(call);
        sendOtpCall = call;
        break;
      } catch {
        // Not the OTP-bearing call — try the next candidate.
      }
    }

    expect(otp, `Expected one of the candidate calls to contain an extractable OTP. Candidate URLs: ${JSON.stringify(candidates.map((c) => c.url))}`).toBeDefined();
    expectSuccessfulApiCall(sendOtpCall!, 'Send OTP');
    expect(otp, 'Expected a valid OTP value in the response').toMatch(/^\d{4,8}$/);
  });

  const apiVerifyOtp = getTestCase('API-002');
  test(apiVerifyOtp.title, { tag: `@${apiVerifyOtp.id}` }, async ({ page, apiCalls, uiAlerts }) => {
    const placeOrderPage = new PlaceOrderPage(page);

    await placeOrderPage.goto();
    await placeOrderPage.waitForReady();
    await placeOrderPage.selectRandomProducts(1);
    await placeOrderPage.openCart();
    const loggedIn = await placeOrderPage.ensureCartLoginCompleted(apiCalls, uiAlerts);
    expect(loggedIn, 'Expected a fresh OTP login to actually run').toBe(true);

    const verifyOtpCall = apiCalls
      .slice()
      .reverse()
      .find((call) => VERIFY_OTP_PATTERN.test(call.url));
    expect(verifyOtpCall, 'Expected a verify-OTP API call to have been captured').toBeDefined();
    expectSuccessfulApiCall(verifyOtpCall!, 'Verify OTP');
  });
});
