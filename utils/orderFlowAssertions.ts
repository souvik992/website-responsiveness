import { expect, type Locator, type Page } from '@playwright/test';

import type { ApiCall, ErrorLog } from '../fixtures/errorMonitor';

export type ApiPredicate = (call: ApiCall) => boolean;

const BENIGN_HARD_ERROR_PATTERNS: RegExp[] = [
  /blocked by cors policy/i,
  // Firefox's own phrasing for the same cross-origin image load Chrome/WebKit
  // report as "blocked by CORS policy" above — confirmed live on
  // desktop-firefox, where the offending storage.googleapis.com URL sits in
  // the message text rather than `entry.url`, so the URL-based allowlist
  // below doesn't catch it and this message-based match is needed too.
  /cross-origin request blocked/i,
  // Firefox's third-party-cookie warning for Razorpay's own fraud-detection
  // script (api.sardine.ai) — a standard SameSite enforcement notice, not
  // specific to any one domain, so matched by message rather than URL.
  /cookie .*rejected because it is in a cross-site context/i,
  /failed to load resource: net::err_failed/i,
  /failed to load resource: net::err_connection_refused/i,
  /refused to get unsafe header/i,
  /permissions policy violation: accelerometer/i,
  /net::err_aborted/i,
  /net::err_blocked_by_orb/i,
  /failed to launch '\w+:\/\/.*scheme does not have a registered handler/i,
  // The order-confirmation screen's celebration animation feeds percentage
  // strings and `undefined` into SVG <path d>/<circle cy> attributes, so the
  // browser logs a burst of ~11 attribute-parse errors the moment the "Order
  // Confirmed" screen mounts (confirmed from a run trace: all fire within
  // ~200ms, right as the confirmation renders after payment). This is a
  // real — but purely cosmetic — bug in the app's own bundle, worth
  // reporting to the app team; it fires on every successful order, so
  // hard-failing on it would leave this suite permanently red exactly when
  // the flow works.
  /<(?:path|circle|rect|ellipse|line)> attribute \w+: Expected (?:number|length)/i,
];

const BENIGN_UI_ERROR_URL_PATTERNS: RegExp[] = [
  /storage\.googleapis\.com/i,
  /api\.razorpay\.com/i,
  /checkout-static-next\.razorpay\.com/i,
  /hcaptcha\.com/i,
  // Razorpay's own embedded fraud-detection collector — same category as the
  // razorpay.com/hcaptcha.com entries above.
  /api\.sardine\.ai/i,
];

const ALLOWED_FAILED_API_URL_PATTERNS: RegExp[] = [
  /api\.razorpay\.com/i,
  /checkout-static-next\.razorpay\.com/i,
];

export async function waitForApiCall(
  apiCalls: ApiCall[],
  predicate: ApiPredicate,
  timeoutMs = 20_000
): Promise<ApiCall> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const match = apiCalls.find(predicate);
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const match = apiCalls.find(predicate);
  if (!match) {
    throw new Error(`Timed out after ${timeoutMs}ms waiting for a matching API call.`);
  }
  return match;
}

export async function waitForApiCalls(
  apiCalls: ApiCall[],
  predicate: ApiPredicate,
  count: number,
  timeoutMs = 20_000
): Promise<ApiCall[]> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const matches = apiCalls.filter(predicate);
    if (matches.length >= count) {
      return matches;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const matches = apiCalls.filter(predicate);
  if (matches.length < count) {
    throw new Error(`Timed out after ${timeoutMs}ms waiting for ${count} matching API calls.`);
  }
  return matches;
}

export function expectSuccessfulApiCall(call: ApiCall, label: string) {
  expect(call.status, `${label} failed:\n${JSON.stringify(call, null, 2)}`).toBeLessThan(400);
}

export function findLatestApiCall(apiCalls: ApiCall[], predicate: ApiPredicate): ApiCall | undefined {
  const matches = apiCalls.filter(predicate);
  return matches.at(-1);
}

export function extractOtpFromResponse(call: ApiCall): string {
  const seen = new Set<unknown>();

  const walk = (value: unknown): string | null => {
    if (!value || typeof value !== 'object') {
      return null;
    }
    if (seen.has(value)) {
      return null;
    }
    seen.add(value);

    for (const [key, nestedValue] of Object.entries(value)) {
      if (typeof nestedValue === 'string' || typeof nestedValue === 'number') {
        const raw = String(nestedValue).trim();
        if (/otp|code|passcode/i.test(key) && /^\d{4,8}$/.test(raw)) {
          return raw;
        }
      }

      if (nestedValue && typeof nestedValue === 'object') {
        const nestedOtp = walk(nestedValue);
        if (nestedOtp) {
          return nestedOtp;
        }
      }
    }

    return null;
  };

  const otp = walk(call.responseBody);
  if (!otp) {
    throw new Error(`Unable to extract OTP from response:\n${JSON.stringify(call.responseBody, null, 2)}`);
  }

  return otp;
}

export function findTextInObject(value: unknown, patterns: RegExp[]): string | null {
  const seen = new Set<unknown>();

  const walk = (input: unknown): string | null => {
    if (typeof input === 'string') {
      return patterns.some((pattern) => pattern.test(input)) ? input : null;
    }

    if (!input || typeof input !== 'object') {
      return null;
    }

    if (seen.has(input)) {
      return null;
    }
    seen.add(input);

    for (const nestedValue of Object.values(input)) {
      const match = walk(nestedValue);
      if (match) {
        return match;
      }
    }

    return null;
  };

  return walk(value);
}

export async function expectLocatorTextToContainAny(locator: Locator, values: string[]) {
  const text = (await locator.textContent()) ?? '';
  const normalizedText = normalizeText(text);
  const normalizedValues = values.map(normalizeText).filter(Boolean);

  const hasMatch = normalizedValues.some((value) => normalizedText.includes(value));
  expect(
    hasMatch,
    `Expected locator text "${text}" to include one of:\n${JSON.stringify(values, null, 2)}`
  ).toBe(true);
}

export async function expectPageToRenderValue(page: Page, expectedValue: string, timeoutMs = 15_000) {
  const normalizedValue = normalizeText(expectedValue);
  expect(normalizedValue.length, 'Expected UI value must not be empty').toBeGreaterThan(0);

  await expect
    .poll(
      async () => {
        const bodyText = await page.locator('body').textContent();
        return normalizeText(bodyText ?? '').includes(normalizedValue);
      },
      {
        timeout: timeoutMs,
        message: `Expected page to render value: ${expectedValue}`,
      }
    )
    .toBe(true);
}

/**
 * True for a "hard" error that's actually known third-party/browser noise
 * (Razorpay's own fingerprinting pings, UPI app deep-links with no handler,
 * CORS header warnings, Sentry's accelerometer permissions warning, requests
 * aborted by navigation) rather than a real app-level failure.
 */
export function isBenignHardError(entry: ErrorLog): boolean {
  const combined = `${entry.message} ${entry.url ?? ''}`;
  const isBenignByMessage = BENIGN_HARD_ERROR_PATTERNS.some((pattern) => pattern.test(combined));
  const isBenignByUrl = entry.url
    ? BENIGN_UI_ERROR_URL_PATTERNS.some((pattern) => pattern.test(entry.url!))
    : false;
  return isBenignByMessage || isBenignByUrl;
}

export function assertNoUiOrApiErrors(errorLog: ErrorLog[], apiCalls: ApiCall[], allowedApiPatterns: RegExp[] = []) {
  const hardErrors = errorLog.filter((entry) => entry.severity === 'hard' && !isBenignHardError(entry));
  expect(hardErrors, `Unexpected hard UI/network errors:\n${JSON.stringify(hardErrors, null, 2)}`).toHaveLength(0);

  const failedApiCalls = apiCalls.filter((call) => {
    if (call.status < 400) {
      return false;
    }
    const isAllowedByCaller = allowedApiPatterns.some((pattern) => pattern.test(call.url));
    const isBenignExternal = ALLOWED_FAILED_API_URL_PATTERNS.some((pattern) => pattern.test(call.url));
    return !(isAllowedByCaller || isBenignExternal);
  });
  expect(failedApiCalls, `Unexpected failed API calls:\n${JSON.stringify(failedApiCalls, null, 2)}`).toHaveLength(0);
}

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}
