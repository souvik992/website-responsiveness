# replit-b2c-playwright

Playwright + TypeScript end-to-end tests for the place-order flow, run against the
[Replit restaurant delivery/takeaway demo template](https://restaurant-website-delivery-takeaway-default-template.replit.app).

## Setup

```bash
npm install
npm run install:browsers
```

## Running tests

```bash
npm test                  # all projects
npm run test:e2e          # tests/e2e only (whichever projects match)
npm run test:desktop      # tests/e2e across every desktop browser/screen project
npm run test:desktop:chrome    # tests/e2e on desktop Chrome only
npm run test:desktop:firefox   # tests/e2e on desktop Firefox only
npm run test:desktop:webkit    # tests/e2e on desktop Safari/WebKit only
npm run test:desktop:edge      # tests/e2e on desktop Edge only
npm run test:headed       # headed mode
npm run test:debug        # Playwright debug mode
npm run test:device-orders   # device-matrix order flow suite
```

Override the target site with `BASE_URL`:

```bash
BASE_URL=https://your-site.example.com npx playwright test
```

## Projects

- `mobile-chrome` / `iphone-xr` — default mobile e2e coverage (`tests/e2e`), excludes the device matrix spec.
- `desktop-chrome` / `desktop-firefox` / `desktop-webkit` / `desktop-edge` — the four major desktop browsers, each at Playwright's default 1280x720 viewport (except `desktop-edge`, which runs the real `msedge` channel and needs `playwright install msedge`).
- `desktop-<engine>-<resolution>` — every browser above crossed with three common real-world screen resolutions (`1920x1080` Full HD, `1366x768` the most common laptop panel, `1440x900` a common 15"-16" laptop resolution) — 12 projects total, e.g. `desktop-firefox-1366x768`. Generated in `playwright.config.ts` via `buildDesktopProjects()` rather than listed by hand.
- `device-orders` — runs `tests/place-order-device-matrix.spec.ts` across a device matrix, one worker at a time.

Every `desktop-*` and mobile project runs the same `tests/e2e` spec, which places a real order through the Razorpay sandbox — running all of them back to back (16 desktop projects + 2 mobile) means one real order per project. `tests/e2e/place-order.spec.ts` never fails the Playwright run itself on a flow error — every step's success/failure is instead recorded into the same device-order report the `device-orders` project uses (see Reports below), so check that report for real pass/fail per browser rather than the green/red Playwright result.

## Running on GitHub Actions

- `.github/workflows/device-order-matrix.yml` — manual-only, shards the 200-device matrix suite.
- `.github/workflows/desktop-e2e.yml` — manual-only (`workflow_dispatch`), matrix job over all 16 `desktop-*` projects above. Each is a separate job, so from the Actions tab you can re-run just one browser/resolution (e.g. only `desktop-webkit-1366x768`) via **Re-run jobs → Re-run failed jobs** or by selecting that specific job, instead of re-running the whole matrix. A `merge-report` job then combines every leg's result into one `desktop-order-report.xlsx` artifact, same structure as the device-matrix's report.

## Reports

- HTML report: `playwright-report/` (`npx playwright show-report`)
- Device-order / desktop-e2e results: both write into `test-results/device-orders/` (JSON result + step screenshots per run) and are merged with `npm run merge:device-orders`, or automatically into `test-results/device-order-report.xlsx` after any local run via `globalTeardown`.

## Structure

- `tests/` — spec files
- `pages/` — page objects
- `utils/` — shared helpers, device matrix config, result storage
- `fixtures/` — custom fixtures (error monitoring, etc.)
