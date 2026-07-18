# replit-b2c-playwright

Playwright + TypeScript end-to-end tests for the place-order flow, run against the
[Replit restaurant delivery/takeaway demo template](https://restaurant-website-delivery-takeaway-default-template.replit.app).

## Setup

```bash
npm install
npm run install:browsers
```

Allure's HTML report generation (`npm run allure:generate`) needs a Java runtime on your machine (GitHub's `ubuntu-latest` runners already have one) — install one locally if you want to generate the Allure report outside CI.

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
npm run test:sanity          # functional Sanity suite (SAN-001..006)
npm run test:e2e-suite       # functional End to End suite (E2E-001..006)
npm run test:api             # functional API Testing suite (API-001..005)
npm run test:functional:all  # all three functional suites in one invocation
npm run report:test-cases    # build test-results/test-case-report.xlsx from the last run's results.json
npm run allure:generate      # build allure-report/ from allure-results/
npm run allure:open          # open the generated Allure report
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
- `functional-suite` — runs the Sanity/End to End/API Testing suite under `functional-tests/` (see below). A sibling `testDir` outside the shared `./tests` directory, so it's entirely invisible to every project above — no existing project's file selection changes.

Every `desktop-*` and mobile project runs the same `tests/e2e` spec, which places a real order through the Razorpay sandbox — running all of them back to back (16 desktop projects + 2 mobile) means one real order per project. `tests/e2e/place-order.spec.ts` never fails the Playwright run itself on a flow error — every step's success/failure is instead recorded into the same device-order report the `device-orders` project uses (see Reports below), so check that report for real pass/fail per browser rather than the green/red Playwright result.

## Functional test suite (Sanity / End to End / API Testing)

`functional-tests/{sanity,e2e,api}/` — a genuine pass/fail QA suite (unlike the two matrix suites above, a real assertion failure here fails the job) with full traceability, built on the same `PlaceOrderPage` POM:

- **`test-cases/testCaseDefinitions.ts`** is the single source of truth — every test case's ID, module, priority (P0/P1/P2), and expected result. Each spec imports its entry and uses `tc.title` for the test title and `@${tc.id}` as its Playwright tag, so the spec and the tracker spreadsheet can never drift apart.
- **Sanity** (SAN-001..006): homepage, catalog, add-to-cart, cart contents, the Delivery/Takeaway onboarding modal, and one full golden-path order.
- **End to End** (E2E-001..006): single- and multi-product order placement, delivery-slot handling, journey-wide stability (no hard UI/console errors), the order-type-onboarding regression (see `PlaceOrderPage.handleOrderTypeModalIfPresent`), and payment-view resilience (UPI vs Netbanking fallback).
- **API Testing** (API-001..005): UI-driven — the real flow is driven as usual, but assertions are made on the network responses already captured by the `apiCalls` fixture (send-OTP, verify-OTP, save-address, create-order, and a journey-wide "no failed API calls" check), not raw HTTP requests bypassing the browser.
- **`scripts/generate-test-case-report.ts`** reads `test-results/results.json` (Playwright's JSON reporter — tags live on `spec.tags`, not `test.tags`) and produces `test-results/test-case-report.xlsx` with 3 tabs matching the categories above: Module | Test Case ID | Title | Priority | Expected Result | Actual Result | Status | Duration.
- **Don't pass `--reporter=` on the CLI** when you want this report or the Allure report — it fully overrides `playwright.config.ts`'s reporter array (confirmed live), silently skipping the `json` and `allure-playwright` reporters this depends on.

## Running on GitHub Actions

- **Mobile Devices Matrix** (`.github/workflows/device-order-matrix.yml`) — manual-only, shards the 200-device matrix suite. Two `workflow_dispatch` inputs let you narrow a run: `devices` (comma-separated exact device names — run `npx tsx scripts/select-device-matrix.ts --list` locally to see every valid name) and `order_count` (a cap on how many devices/orders to run, applied after the `devices` filter if both are set). Leave both blank to run all ~200, same as before. A `select-devices` job resolves the filters into a `--grep` pattern and a right-sized shard count (e.g. requesting 3 devices runs 3 shards, not 8) before the real matrix job starts. Each shard uploads its own intermediate artifact, but a `merge-report` job combines every shard into one `device-order-report` artifact (the xlsx report at its root, one screenshot folder per device) and deletes the per-shard intermediates afterward — only that one artifact remains once the workflow finishes.
- **Desktop and Browser Matrix** (`.github/workflows/desktop-e2e.yml`) — manual-only (`workflow_dispatch`), matrix job over all 16 `desktop-*` projects above. Each is a separate job, so from the Actions tab you can re-run just one browser/resolution (e.g. only `desktop-webkit-1366x768`) via **Re-run jobs → Re-run failed jobs** or by selecting that specific job, instead of re-running the whole matrix. Same as the mobile workflow, a `merge-report` job combines every leg into one `desktop-order-report` artifact and deletes the per-project intermediates afterward.
- **Functional Test Suite** (`.github/workflows/functional-test-suite.yml`) — manual-only, with a `suite` dropdown (sanity/e2e/api/all) picking which directory(ies) to run. Unlike the two matrix workflows, this one genuinely fails the job on a real assertion failure. Produces one `functional-test-report` artifact containing the xlsx test-case tracker plus the generated Allure HTML report.
- **Place Order** (`.github/workflows/place-order.yml`) — manual-only, one `order_count` input: how many real orders to place back-to-back on a single browser (default `1`). Maps straight to Playwright's own `--repeat-each` flag against a new `place-order-repeat` project (`repeat-order-tests/`) — each repetition gets a fresh browser context and its own row in the Excel report, keyed by attempt number. Produces one `place-order-report` artifact (xlsx + one screenshot folder per attempt). Not tied to any specific device/browser — for that, use Mobile Devices Matrix's `devices`/`order_count` inputs instead.

## Reports

- HTML report: `playwright-report/` (`npx playwright show-report`)
- Device-order / desktop-e2e results: both write into `test-results/device-orders/` (JSON result + step screenshots per run) and are merged with `npm run merge:device-orders`, or automatically into `test-results/device-order-report.xlsx` after any local run via `globalTeardown`. On GitHub Actions, both workflows' `merge-report` job produces exactly one downloadable artifact — the xlsx report plus one screenshot folder per device/browser — with every intermediate per-shard/per-project artifact deleted afterward.
- The Summary sheet's **Compatibility Issue Description** column now also surfaces the actual error (failed step + message) whenever a run fails before any layout check even ran, not just genuine layout/console issues.
- Functional test-case tracker: `test-results/test-case-report.xlsx` (`npm run report:test-cases`), 3 tabs (Sanity / End to End / API Testing).
- Allure report: `allure-report/` (`npm run allure:generate`, then `npm run allure:open`) — wired in globally, so it also covers the device-matrix and desktop-matrix suites, not just the functional one.

## Structure

- `tests/` — spec files (device matrix + per-browser e2e)
- `functional-tests/` — Sanity/End to End/API Testing spec files (sibling to `tests/`, its own project)
- `test-cases/` — `testCaseDefinitions.ts`, the source of truth for the functional suite's test-case metadata
- `pages/` — page objects
- `utils/` — shared helpers, device matrix config, result storage
- `fixtures/` — custom fixtures (error monitoring, etc.)
- `scripts/` — report generators (`merge-device-order-results.ts`, `generate-test-case-report.ts`)
