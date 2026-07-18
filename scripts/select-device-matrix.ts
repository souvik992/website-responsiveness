import fs from 'fs';
import { mobileDeviceNames, tabletDeviceNames, landscapeDeviceNames } from '../utils/deviceMatrix';

/**
 * Selects a subset of tests/place-order-device-matrix.spec.ts's device
 * matrix without touching that file — it builds the exact same ordered list
 * (mobile, then tablet, then landscape) the spec builds internally, then
 * emits a `--grep` pattern (each test's title is `${deviceName} [...]`, so
 * anchoring on `name + " ["` avoids one device name matching as a prefix of
 * another, e.g. "iPhone 13" vs "iPhone 13 Pro Max") plus a right-sized shard
 * count for the CI workflow's matrix.
 *
 * `--list` prints every valid device name (for picking values for the
 * `devices` workflow input) and exits.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const masterList = [...mobileDeviceNames, ...tabletDeviceNames, ...landscapeDeviceNames];

function categoryFor(name: string): 'mobile' | 'tablet' | 'landscape' {
  if (landscapeDeviceNames.includes(name)) return 'landscape';
  if (tabletDeviceNames.includes(name)) return 'tablet';
  return 'mobile';
}

if (process.argv.includes('--list')) {
  for (const name of masterList) {
    console.log(`${name}  [${categoryFor(name)}]`);
  }
  console.log(`\n${masterList.length} device(s) total.`);
  process.exit(0);
}

const devicesInput = (process.env.DEVICES ?? '').trim();
const countInput = (process.env.COUNT ?? '').trim();

let selected = masterList;

if (devicesInput.length > 0) {
  const requested = devicesInput
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const unknown = requested.filter((name) => !masterList.includes(name));
  if (unknown.length > 0) {
    console.error(`Unknown device name(s): ${unknown.join(', ')}`);
    console.error('Run `npx tsx scripts/select-device-matrix.ts --list` to see every valid device name (case-sensitive, exact match).');
    process.exit(1);
  }

  selected = masterList.filter((name) => requested.includes(name));
}

if (countInput.length > 0) {
  const n = Number(countInput);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`order_count must be a positive integer, got "${countInput}".`);
    process.exit(1);
  }
  selected = selected.slice(0, n);
}

if (selected.length === 0) {
  console.error('No devices matched the given devices/order_count filters — nothing to run.');
  process.exit(1);
}

const filtered = selected.length < masterList.length;
const grep = filtered ? selected.map((name) => `${escapeRegex(name)} \\[`).join('|') : '';
const shardCount = Math.min(8, selected.length);
const shardsJson = JSON.stringify(Array.from({ length: shardCount }, (_, i) => i + 1));

console.log(`Selected ${selected.length}/${masterList.length} device(s):`);
for (const name of selected) {
  console.log(`  - ${name} [${categoryFor(name)}]`);
}
console.log(`Running across ${shardCount} shard(s).`);

const outputPath = process.env.GITHUB_OUTPUT;
if (outputPath) {
  fs.appendFileSync(
    outputPath,
    `total=${selected.length}\n` + `grep=${grep}\n` + `shard_count=${shardCount}\n` + `shards_json=${shardsJson}\n`
  );
}
