import { readAllResults, REPORT_PATH } from './resultsStore';
import { generateDeviceOrderExcelReport } from './excelReport';

/**
 * Runs once, after every worker has finished. Writing the Excel workbook
 * here (rather than per-test) is what lets the report reflect every device
 * result written so far even if the run is interrupted partway through —
 * this suite can take hours for the full device matrix. Mirrors
 * dumdurrust-playwright's utils/responsive/globalTeardown.ts.
 */
export default async function globalTeardown(): Promise<void> {
  const results = readAllResults();
  if (results.length === 0) return; // device-order suite didn't run this invocation

  await generateDeviceOrderExcelReport(results, REPORT_PATH);
  console.log(`\n[device-orders] Wrote ${results.length} device result(s) to ${REPORT_PATH}`);
}
