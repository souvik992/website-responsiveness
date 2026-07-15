import { Page } from '@playwright/test';

export type ResponsiveStatus = 'PASS' | 'WARNING' | 'FAIL';

const OVERFLOW_TOLERANCE_PX = 5;

/**
 * Same class of known third-party/asset noise that fixtures/errorMonitor.ts
 * marks 'soft' and utils/orderFlowAssertions.ts's isBenignHardError ignores
 * for the e2e suite (CORS-blocked CDN images, Razorpay/hCaptcha embeds,
 * aborted-by-navigation requests). Without this, a single flaky CDN asset
 * would FAIL every device/browser in the matrix rather than the actual page.
 */
const BENIGN_CONSOLE_PATTERNS: RegExp[] = [
  /blocked by cors policy/i,
  /is not allowed by access-control-allow-origin/i,
  /failed to load resource: net::err_failed/i,
  /net::err_aborted/i,
  /net::err_blocked_by_orb/i,
  /permissions policy violation: accelerometer/i,
  /storage\.googleapis\.com/i,
  /razorpay\.com/i,
  /hcaptcha\.com/i,
  /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)(\?|"|$)/i,
];

function isBenignConsoleError(message: string): boolean {
  return BENIGN_CONSOLE_PATTERNS.some((pattern) => pattern.test(message));
}

export interface ClippedElement {
  selector: string;
  reason: string;
}

export interface OverlappingPair {
  a: string;
  b: string;
}

export interface ResponsiveCheckResult {
  overflow: { hasOverflow: boolean; scrollWidth: number; innerWidth: number; diff: number };
  clippedElements: ClippedElement[];
  overlappingElements: OverlappingPair[];
  consoleErrors: string[];
  status: ResponsiveStatus;
  issueType: string;
  issueDescription: string;
}

/**
 * Must be attached before navigation — console/pageerror events fire during
 * page load, before the caller gets a chance to inspect anything.
 */
export function attachConsoleErrorCollector(page: Page): string[] {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    consoleErrors.push(err.message);
  });
  return consoleErrors;
}

async function detectOverflow(page: Page) {
  return page.evaluate((tolerance) => {
    const scrollWidth = document.documentElement.scrollWidth;
    const innerWidth = window.innerWidth;
    const diff = scrollWidth - innerWidth;
    return { hasOverflow: diff > tolerance, scrollWidth, innerWidth, diff };
  }, OVERFLOW_TOLERANCE_PX);
}

const KEY_LAYOUT_SELECTORS = [
  'header',
  'nav',
  'footer',
  'main button',
  'button[type="submit"]',
  '[role="button"]',
];

async function detectClippedElements(page: Page): Promise<ClippedElement[]> {
  return page.evaluate(
    ({ selectors, tolerance }) => {
      const results: { selector: string; reason: string }[] = [];
      const seen = new Set<Element>();

      for (const selector of selectors) {
        const elements = Array.from(document.querySelectorAll(selector)).slice(0, 15);
        for (const el of elements) {
          if (seen.has(el)) continue;
          seen.add(el);

          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;

          const label = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (el.className && typeof el.className === 'string' ? `.${el.className.split(' ').filter(Boolean).slice(0, 2).join('.')}` : '');

          if (rect.right > window.innerWidth + tolerance) {
            results.push({ selector: label, reason: `extends ${Math.round(rect.right - window.innerWidth)}px past viewport right edge` });
            continue;
          }
          if (rect.left < -tolerance) {
            results.push({ selector: label, reason: `extends ${Math.round(-rect.left)}px past viewport left edge` });
            continue;
          }

          // Ancestor clipping: walk up looking for an overflow:hidden box
          // that is narrower/shorter than this element's own box.
          let ancestor = el.parentElement;
          let depth = 0;
          while (ancestor && depth < 6) {
            const style = window.getComputedStyle(ancestor);
            if (style.overflow === 'hidden' || style.overflowX === 'hidden') {
              const ancestorRect = ancestor.getBoundingClientRect();
              if (rect.right > ancestorRect.right + tolerance || rect.left < ancestorRect.left - tolerance) {
                results.push({ selector: label, reason: `clipped by ancestor ${ancestor.tagName.toLowerCase()} with overflow:hidden` });
                break;
              }
            }
            ancestor = ancestor.parentElement;
            depth += 1;
          }
        }
      }
      return results;
    },
    { selectors: KEY_LAYOUT_SELECTORS, tolerance: OVERFLOW_TOLERANCE_PX }
  );
}

async function detectOverlappingElements(page: Page): Promise<OverlappingPair[]> {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]')).filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
    }) as HTMLElement[];

    const limited = candidates.slice(0, 40);
    const label = (el: Element) =>
      el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (el.textContent ? `("${el.textContent.trim().slice(0, 20)}")` : '');

    const pairs: { a: string; b: string }[] = [];

    for (let i = 0; i < limited.length; i += 1) {
      for (let j = i + 1; j < limited.length; j += 1) {
        const elA = limited[i];
        const elB = limited[j];
        // Skip ancestor/descendant pairs — nesting is normal, not overlap.
        if (elA.contains(elB) || elB.contains(elA)) continue;

        const rectA = elA.getBoundingClientRect();
        const rectB = elB.getBoundingClientRect();

        const overlapWidth = Math.min(rectA.right, rectB.right) - Math.max(rectA.left, rectB.left);
        const overlapHeight = Math.min(rectA.bottom, rectB.bottom) - Math.max(rectA.top, rectB.top);

        if (overlapWidth > 4 && overlapHeight > 4) {
          const smallerArea = Math.min(rectA.width * rectA.height, rectB.width * rectB.height);
          const overlapArea = overlapWidth * overlapHeight;
          // Only flag when the overlap is a meaningful fraction of the
          // smaller element — avoids false positives from 1-2px shadows/borders.
          if (smallerArea > 0 && overlapArea / smallerArea > 0.3) {
            pairs.push({ a: label(elA), b: label(elB) });
          }
        }
      }
    }

    return pairs.slice(0, 10);
  });
}

export async function runResponsiveChecks(page: Page, rawConsoleErrors: string[]): Promise<ResponsiveCheckResult> {
  const [overflow, clippedElements, overlappingElements] = await Promise.all([
    detectOverflow(page),
    detectClippedElements(page),
    detectOverlappingElements(page),
  ]);

  const consoleErrors = rawConsoleErrors.filter((message) => !isBenignConsoleError(message));

  const issues: string[] = [];
  const issueTypes: string[] = [];

  if (overflow.hasOverflow) {
    issueTypes.push('Horizontal Overflow');
    issues.push(`Page scrolls horizontally: scrollWidth=${overflow.scrollWidth}px vs innerWidth=${overflow.innerWidth}px (+${overflow.diff}px)`);
  }
  if (clippedElements.length > 0) {
    issueTypes.push('Clipped Element');
    issues.push(clippedElements.map((c) => `${c.selector}: ${c.reason}`).join('; '));
  }
  if (overlappingElements.length > 0) {
    issueTypes.push('Overlapping Elements');
    issues.push(overlappingElements.map((o) => `${o.a} overlaps ${o.b}`).join('; '));
  }
  if (consoleErrors.length > 0) {
    issueTypes.push('Console Error');
    issues.push(consoleErrors.slice(0, 5).join(' | '));
  }

  let status: ResponsiveStatus = 'PASS';
  if (overflow.hasOverflow && overflow.diff > 40) status = 'FAIL';
  else if (clippedElements.length > 0 || overlappingElements.length > 0 || consoleErrors.length > 0) status = 'FAIL';
  else if (overflow.hasOverflow) status = 'WARNING';

  return {
    overflow,
    clippedElements,
    overlappingElements,
    consoleErrors,
    status,
    issueType: issueTypes.join(', ') || 'None',
    issueDescription: issues.join(' || ') || '-',
  };
}
