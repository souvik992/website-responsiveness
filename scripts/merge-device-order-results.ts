import fs from 'fs';
import path from 'path';
import { generateDeviceOrderExcelReport } from '../utils/deviceOrders/excelReport';
import { DeviceOrderResult } from '../utils/deviceOrders/types';

/**
 * Combines per-device JSON results from every CI shard's downloaded
 * artifact into one Excel report. Each shard's artifact (see
 * .github/workflows/device-order-matrix.yml) extracts to
 * `<inputDir>/device-order-results-shard-N/results/*.json` — this walks
 * every shard subdirectory it finds rather than hardcoding shard names, so
 * the shard count can change without this script needing an update.
 *
 * Run: npx tsx scripts/merge-device-order-results.ts <mergedResultsDir> <outputXlsxPath>
 */
function readAllResultsFrom(rootDir: string): DeviceOrderResult[] {
  const results: DeviceOrderResult[] = [];
  if (!fs.existsSync(rootDir)) return results;

  const shardDirs = fs.readdirSync(rootDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const shardDir of shardDirs) {
    const resultsDir = path.join(rootDir, shardDir.name, 'results');
    if (!fs.existsSync(resultsDir)) continue;

    for (const file of fs.readdirSync(resultsDir)) {
      if (!file.endsWith('.json')) continue;
      results.push(JSON.parse(fs.readFileSync(path.join(resultsDir, file), 'utf-8')) as DeviceOrderResult);
    }
  }
  return results;
}

async function main() {
  const [, , inputDir, outputPath] = process.argv;
  if (!inputDir || !outputPath) {
    console.error('Usage: merge-device-order-results.ts <mergedResultsDir> <outputXlsxPath>');
    process.exit(1);
  }

  const results = readAllResultsFrom(inputDir);
  if (results.length === 0) {
    console.error(`No device result JSON files found under ${inputDir} — nothing to merge.`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await generateDeviceOrderExcelReport(results, outputPath);
  console.log(`Merged ${results.length} device result(s) from ${inputDir} into ${outputPath}`);
}

main();
