import fs from 'fs';
import path from 'path';
import { DeviceOrderResult } from './types';

export const RESULTS_DIR = path.join(process.cwd(), 'test-results', 'device-orders', 'results');
export const SCREENSHOTS_ROOT_DIR = path.join(process.cwd(), 'test-results', 'device-orders', 'screenshots');
export const REPORT_PATH = path.join(process.cwd(), 'test-results', 'device-order-report.xlsx');

/**
 * This suite runs a single worker sequentially (see the `serial` describe
 * mode in the spec) for hours at a time, so a JSON-per-device file — written
 * the moment each device finishes, not held in memory until the end — is
 * what lets a mid-run crash or interruption still leave a report-able
 * partial result behind, and lets the report be regenerated at any time
 * without re-running the whole matrix.
 */
export function writeResult(id: string, result: DeviceOrderResult): void {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RESULTS_DIR, `${id}.json`), JSON.stringify(result), 'utf-8');
}

export function readAllResults(): DeviceOrderResult[] {
  if (!fs.existsSync(RESULTS_DIR)) return [];
  return fs
    .readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf-8')) as DeviceOrderResult);
}

export function clearResults(): void {
  if (fs.existsSync(RESULTS_DIR)) {
    fs.rmSync(RESULTS_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

export function screenshotDirFor(deviceId: string): string {
  const dir = path.join(SCREENSHOTS_ROOT_DIR, deviceId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
