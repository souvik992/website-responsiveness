import type { Page } from '@playwright/test';
import type { ApiCall, ErrorLog, UiAlert } from '../fixtures/errorMonitor';

/**
 * Plain-function versions of fixtures/errorMonitor.ts's apiCalls/errorLog/
 * uiAlerts fixtures, for pages created manually (`browser.newContext()` +
 * `context.newPage()`) rather than through Playwright's own `page` fixture —
 * needed by any suite that must pair each test case with its own browser
 * engine/device context in a loop (the device fixture can't do that; its
 * `use:` block is fixed per project). Mirrors the same logic exactly, just
 * without the `test.extend` wrapper. Same idea as
 * utils/deviceChecks.ts's `attachConsoleErrorCollector`.
 */

const IGNORED_PATTERNS: RegExp[] = [
  /google-analytics/,
  /googletagmanager/,
  /facebook\.net/,
  /clarity\.ms/,
  /hotjar/,
  /sentry\.io/,
  /favicon\.ico/,
];

const SOFT_FAIL_RESOURCE_TYPES = new Set(['image', 'font', 'stylesheet', 'media']);

function isIgnored(value: string): boolean {
  return IGNORED_PATTERNS.some((pattern) => pattern.test(value));
}

/** Must be attached before navigation — request/response events fire during page load. */
export function attachApiCallMonitor(page: Page): ApiCall[] {
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

    if (status >= 400) {
      console.error(`[api-failure] ${req.method().padEnd(6)} [${status}] ${req.url()}`);
    }
  });

  return apiCalls;
}

/** Must be attached before navigation. */
export function attachErrorLogMonitor(page: Page): ErrorLog[] {
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
    const severity: ErrorLog['severity'] = SOFT_FAIL_RESOURCE_TYPES.has(req.resourceType()) ? 'soft' : 'hard';
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
      const severity: ErrorLog['severity'] = SOFT_FAIL_RESOURCE_TYPES.has(req.resourceType()) ? 'soft' : 'hard';
      errors.push({
        type: 'http_error',
        message: `${res.status()} ${res.statusText()}`,
        url: res.url(),
        severity,
      });
    }
  });

  return errors;
}

const ERROR_ALERT_TEXT_PATTERN = /fail|error|invalid|wrong|unable|not available|something went wrong|try again|denied|expired|rejected/i;

/** Must be awaited before navigation — it registers an exposed function and init script the page needs from first load. */
export async function attachUiAlertMonitor(page: Page): Promise<UiAlert[]> {
  const alerts: UiAlert[] = [];

  await page.exposeFunction('__reportUiAlert', (message: string) => {
    const text = message.replace(/\s+/g, ' ').trim();
    if (!text) return;

    const looksLikeError = ERROR_ALERT_TEXT_PATTERN.test(text);
    alerts.push({ message: text, looksLikeError, timestamp: Date.now() });
    console.log(`[snackbar]${looksLikeError ? '[ERROR]' : ''} ${text}`);
  });

  await page.addInitScript(() => {
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

  return alerts;
}
