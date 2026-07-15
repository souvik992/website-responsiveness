import { test as base, type Page } from '@playwright/test';

export interface ApiCall {
  url: string;
  method: string;
  requestPayload: any;
  status: number;
  responseBody: any;
  duration: number;
  resourceType: string;
}

export interface ErrorLog {
  type: 'console.error' | 'pageerror' | 'requestfailed' | 'http_error';
  message: string;
  url?: string;
  /** 'hard' = fails the test (API/logic level). 'soft' = logged/reported only (asset level). */
  severity: 'hard' | 'soft';
}

/** URL/message patterns to ignore — third-party noise that isn't actionable */
const IGNORED_PATTERNS: RegExp[] = [
  /google-analytics/,
  /googletagmanager/,
  /facebook\.net/,
  /clarity\.ms/,
  /hotjar/,
  /sentry\.io/,
  /favicon\.ico/,
];

/** Resource types whose failures are real bugs worth reporting, but shouldn't
 *  hard-fail an API/logic-focused test the same way an XHR/fetch failure does. */
const SOFT_FAIL_RESOURCE_TYPES = new Set(['image', 'font', 'stylesheet', 'media']);

function isIgnored(value: string): boolean {
  return IGNORED_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Cross-browser geolocation mock using a FIXED coordinate. Use this when you
 * want a specific, repeatable lat/lng (e.g. testing a known serviceable zone)
 * rather than the config-level permissions/geolocation grant.
 */
export async function mockGeolocation(page: Page, latitude: number, longitude: number) {
  await page.addInitScript(`
    const coords = { latitude: ${latitude}, longitude: ${longitude}, accuracy: 100 };
    const mockPosition = {
      coords: { ...coords, altitude: null, altitudeAccuracy: null, heading: null, speed: null },
      timestamp: Date.now(),
    };
    Object.defineProperty(navigator, 'geolocation', {
      value: {
        getCurrentPosition: (success) => { setTimeout(() => success(mockPosition), 0); },
        watchPosition: (success) => { setTimeout(() => success(mockPosition), 0); return 0; },
        clearWatch: () => {},
      },
      configurable: true,
    });

    try {
      if (navigator.permissions && navigator.permissions.query) {
        const originalQuery = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = (params) => {
          if (params && params.name === 'geolocation') {
            return Promise.resolve({ state: 'granted', onchange: null });
          }
          return originalQuery(params);
        };
      }
    } catch (e) {
      // Non-fatal: native permission grant (context.permissions) still applies on Chromium.
    }
  `);
}

export interface UiAlert {
  /** Visible text of the snackbar/toast/alert at the moment it appeared. */
  message: string;
  /** Best-effort guess at whether this looked like an error toast vs. e.g. a success toast. */
  looksLikeError: boolean;
  timestamp: number;
}

type Fixtures = {
  apiCalls: ApiCall[];
  errorLog: ErrorLog[];
  uiAlerts: UiAlert[];
};

/** Keywords that mark a snackbar/toast as worth calling out as an error in the console log. */
const ERROR_ALERT_TEXT_PATTERN = /fail|error|invalid|wrong|unable|not available|something went wrong|try again|denied|expired|rejected/i;

export const test = base.extend<Fixtures>({
  apiCalls: async ({ page }: { page: Page }, use: (calls: ApiCall[]) => Promise<void>) => {
    const apiCalls: ApiCall[] = [];
    const requestTimings = new Map<string, number>();

    page.on('request', (req) => {
      if (['xhr', 'fetch'].includes(req.resourceType())) {
        requestTimings.set(req.url() + req.method(), Date.now());
      }
    });

    page.on('response', async (res) => {
      const req = res.request();
      if (!['xhr', 'fetch'].includes(req.resourceType())) return;
      if (isIgnored(req.url())) return;

      let requestPayload: any = null;
      try {
        requestPayload = req.postData() ? JSON.parse(req.postData()!) : null;
      } catch {
        requestPayload = req.postData();
      }

      let responseBody: any = null;
      try {
        responseBody = await res.json();
      } catch {
        responseBody = await res.text().catch(() => null);
      }

      const key = req.url() + req.method();
      const startTime = requestTimings.get(key) ?? Date.now();
      const status = res.status();

      apiCalls.push({
        url: req.url(),
        method: req.method(),
        requestPayload,
        status,
        responseBody,
        duration: Date.now() - startTime,
        resourceType: req.resourceType(),
      });

      // Surface every failing API call the moment it happens, not just when a
      // test later asserts on the collected list — this is what lets a human
      // watching the console (or CI logs) see backend problems in real time.
      if (status >= 400) {
        console.error(`[api-failure] ${req.method().padEnd(6)} [${status}] ${req.url()}`);
      }
    });

    await use(apiCalls);
  },

  errorLog: async ({ page }: { page: Page }, use: (errors: ErrorLog[]) => Promise<void>) => {
    const errors: ErrorLog[] = [];
    const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)(\?|$)/i;

    page.on('console', (msg) => {
      if (msg.type() === 'error' && !isIgnored(msg.text())) {
        const severity: ErrorLog['severity'] = IMAGE_EXT.test(msg.text()) ? 'soft' : 'hard';
        const location = msg.location()?.url;
        errors.push({ type: 'console.error', message: msg.text(), url: location || undefined, severity });
      }
    });

    page.on('pageerror', (err) => {
      errors.push({ type: 'pageerror', message: err.message, severity: 'hard' });
    });

    page.on('requestfailed', (req) => {
      if (isIgnored(req.url())) return;
      const severity: ErrorLog['severity'] = SOFT_FAIL_RESOURCE_TYPES.has(req.resourceType())
        ? 'soft'
        : 'hard';
      errors.push({
        type: 'requestfailed',
        message: req.failure()?.errorText || 'unknown failure',
        url: req.url(),
        severity,
      });
    });

    page.on('response', (res) => {
      const req = res.request();
      if (res.status() >= 400 && !isIgnored(res.url())) {
        const severity: ErrorLog['severity'] = SOFT_FAIL_RESOURCE_TYPES.has(req.resourceType())
          ? 'soft'
          : 'hard';
        errors.push({
          type: 'http_error',
          message: `${res.status()} ${res.statusText()}`,
          url: res.url(),
          severity,
        });
      }
    });

    await use(errors);
  },

  uiAlerts: async ({ page }: { page: Page }, use: (alerts: UiAlert[]) => Promise<void>) => {
    const alerts: UiAlert[] = [];

    // The browser-side observer calls back into Node the instant a snackbar/toast
    // appears, so alerts are logged live instead of being discovered by polling.
    await page.exposeFunction('__reportUiAlert', (message: string) => {
      const text = message.replace(/\s+/g, ' ').trim();
      if (!text) return;

      const looksLikeError = ERROR_ALERT_TEXT_PATTERN.test(text);
      alerts.push({ message: text, looksLikeError, timestamp: Date.now() });
      console.log(`[snackbar]${looksLikeError ? '[ERROR]' : ''} ${text}`);
    });

    await page.addInitScript(() => {
      // Covers Material UI's Snackbar/Alert components plus any element using the
      // standard ARIA live-region roles that toast libraries commonly render with.
      const ALERT_SELECTOR = '.MuiSnackbar-root, .MuiAlert-root, [role="alert"]';
      const alreadyReported = new WeakSet<Element>();

      const report = (element: Element) => {
        if (alreadyReported.has(element)) return;
        const text = (element.textContent || '').trim();
        if (!text) return;
        alreadyReported.add(element);
        (window as unknown as { __reportUiAlert?: (msg: string) => void }).__reportUiAlert?.(text);
      };

      const scanForAlerts = (root: Element | Document) => {
        if (root instanceof Element && root.matches(ALERT_SELECTOR)) {
          report(root);
        }
        root.querySelectorAll(ALERT_SELECTOR).forEach(report);
      };

      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          mutation.addedNodes.forEach((node) => {
            if (node instanceof Element) scanForAlerts(node);
          });
        }
      });

      const startObserving = () => {
        scanForAlerts(document);
        observer.observe(document.body, { childList: true, subtree: true });
      };

      if (document.body) {
        startObserving();
      } else {
        document.addEventListener('DOMContentLoaded', startObserving, { once: true });
      }
    });

    await use(alerts);
  },
});

export { expect } from '@playwright/test';