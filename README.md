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
npm run test:e2e          # tests/e2e only
npm run test:headed       # headed mode
npm run test:debug        # Playwright debug mode
npm run test:device-orders   # device-matrix order flow suite
```

Override the target site with `BASE_URL`:

```bash
BASE_URL=https://your-site.example.com npx playwright test
```

## Projects

- `mobile-chrome` / `chromium` — default e2e suite (`tests/e2e`), excludes the device matrix spec.
- `device-orders` — runs `tests/place-order-device-matrix.spec.ts` across a device matrix, one worker at a time.

## Reports

- HTML report: `playwright-report/` (`npx playwright show-report`)
- Device-order matrix results: merge with `npm run merge:device-orders`

## Structure

- `tests/` — spec files
- `pages/` — page objects
- `utils/` — shared helpers, device matrix config, result storage
- `fixtures/` — custom fixtures (error monitoring, etc.)
