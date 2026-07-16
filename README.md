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
- `desktop-1920x1080` / `desktop-1366x768` / `desktop-1440x900` — desktop Chrome at common real-world screen resolutions (Full HD, the most common laptop panel, and a common 15"-16" laptop resolution).
- `device-orders` — runs `tests/place-order-device-matrix.spec.ts` across a device matrix, one worker at a time.

Every `desktop-*` and mobile project runs the same `tests/e2e` spec, which places a real order through the Razorpay sandbox — running all of them back to back means one real order per project.

## Running on GitHub Actions

- `.github/workflows/device-order-matrix.yml` — manual-only, shards the 200-device matrix suite.
- `.github/workflows/desktop-e2e.yml` — manual-only (`workflow_dispatch`), matrix job over the 7 `desktop-*` projects above. Each is a separate job, so from the Actions tab you can re-run just one browser (e.g. only `desktop-webkit`) via **Re-run jobs → Re-run failed jobs** or by selecting that specific job, instead of re-running the whole matrix.

## Reports

- HTML report: `playwright-report/` (`npx playwright show-report`)
- Device-order matrix results: merge with `npm run merge:device-orders`

## Structure

- `tests/` — spec files
- `pages/` — page objects
- `utils/` — shared helpers, device matrix config, result storage
- `fixtures/` — custom fixtures (error monitoring, etc.)
