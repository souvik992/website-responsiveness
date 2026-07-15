import ExcelJS from 'exceljs';
import { DeviceOrderResult } from './types';

const STATUS_FILL: Record<string, string> = {
  PASS: 'FFC6EFCE',
  WARNING: 'FFFFEB9C',
  FAIL: 'FFFFC7CE',
};

const STATUS_FONT: Record<string, string> = {
  PASS: 'FF006100',
  WARNING: 'FF9C6500',
  FAIL: 'FF9C0006',
};

const SUMMARY_HEADERS = [
  'Device',
  'Browser',
  'Resolution',
  'Category',
  'Order Status',
  'Order ID / Number',
  'Payment Method',
  'Failed Step',
  'Order Error',
  'Compatibility Status',
  'Compatibility Issue Type',
  'Compatibility Issue Description',
  'Duration (s)',
  'Screenshot Folder',
];

function summaryRow(r: DeviceOrderResult): (string | number)[] {
  return [
    r.device,
    r.browser,
    r.resolution,
    r.category,
    r.orderStatus,
    r.orderNumber || r.orderId,
    r.paymentMethod,
    r.failedStep,
    r.orderError,
    r.compatibilityStatus,
    r.compatibilityIssueType,
    r.compatibilityIssueDescription,
    Math.round(r.durationMs / 1000),
    r.screenshotDir,
  ];
}

function styleStatusCell(cell: ExcelJS.Cell, status: string) {
  if (!STATUS_FILL[status]) return;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STATUS_FILL[status] } };
  cell.font = { color: { argb: STATUS_FONT[status] }, bold: true };
}

function addSummaryHeader(sheet: ExcelJS.Worksheet, results: DeviceOrderResult[]) {
  const total = results.length;
  const orderPass = results.filter((r) => r.orderStatus === 'PASS').length;
  const orderFail = total - orderPass;
  const compatPass = results.filter((r) => r.compatibilityStatus === 'PASS').length;
  const compatWarn = results.filter((r) => r.compatibilityStatus === 'WARNING').length;
  const compatFail = results.filter((r) => r.compatibilityStatus === 'FAIL').length;

  sheet.addRow(['Place Order — Device Compatibility & Order Placement Report']);
  sheet.getRow(1).font = { bold: true, size: 14 };
  sheet.addRow([
    `Devices tested: ${total}`,
    `Orders placed: ${orderPass}`,
    `Orders failed: ${orderFail}`,
    `Compat pass: ${compatPass}`,
    `Compat warn: ${compatWarn}`,
    `Compat fail: ${compatFail}`,
  ]);
  sheet.getRow(2).font = { bold: true };
  sheet.addRow([]);
}

function buildSummarySheet(workbook: ExcelJS.Workbook, results: DeviceOrderResult[]) {
  const sheet = workbook.addWorksheet('Summary');
  addSummaryHeader(sheet, results);

  const headerRowIndex = sheet.rowCount + 1;
  const headerRow = sheet.addRow(SUMMARY_HEADERS);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
  });

  for (const r of results) {
    const row = sheet.addRow(summaryRow(r));
    styleStatusCell(row.getCell(5), r.orderStatus);
    styleStatusCell(row.getCell(10), r.compatibilityStatus);
    row.getCell(14).font = { underline: true, color: { argb: 'FF0563C1' } };
  }

  sheet.views = [{ state: 'frozen', ySplit: headerRowIndex }];
  sheet.autoFilter = { from: { row: headerRowIndex, column: 1 }, to: { row: headerRowIndex, column: SUMMARY_HEADERS.length } };

  sheet.columns.forEach((col, idx) => {
    const header = SUMMARY_HEADERS[idx] ?? '';
    const maxContentLength = Math.max(header.length, ...results.map((r) => String(summaryRow(r)[idx] ?? '').length));
    col.width = Math.min(Math.max(maxContentLength + 2, 12), 60);
  });
}

function buildOrderFailuresSheet(workbook: ExcelJS.Workbook, results: DeviceOrderResult[]) {
  const sheet = workbook.addWorksheet('Order Placement Failures');
  const headers = ['Device', 'Browser', 'Category', 'Failed Step', 'Order Error', 'Screenshot Folder'];
  const headerRow = sheet.addRow(headers);
  headerRow.font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const failures = results.filter((r) => r.orderStatus === 'FAIL');
  for (const r of failures) {
    const row = sheet.addRow([r.device, r.browser, r.category, r.failedStep, r.orderError, r.screenshotDir]);
    styleStatusCell(row.getCell(1), 'FAIL');
    row.getCell(6).font = { underline: true, color: { argb: 'FF0563C1' } };
  }

  sheet.columns.forEach((col, idx) => {
    const header = headers[idx] ?? '';
    const maxContentLength = Math.max(
      header.length,
      ...failures.map((r) => String([r.device, r.browser, r.category, r.failedStep, r.orderError, r.screenshotDir][idx] ?? '').length)
    );
    col.width = Math.min(Math.max(maxContentLength + 2, 12), 70);
  });
}

function buildCompatibilityIssuesSheet(workbook: ExcelJS.Workbook, results: DeviceOrderResult[]) {
  const sheet = workbook.addWorksheet('Compatibility Issues');
  const headers = ['Device', 'Browser', 'Resolution', 'Category', 'Status', 'Issue Type', 'Issue Description', 'Screenshot Folder'];
  const headerRow = sheet.addRow(headers);
  headerRow.font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const issues = results
    .filter((r) => r.compatibilityStatus !== 'PASS')
    .sort((a, b) => (a.compatibilityStatus === b.compatibilityStatus ? 0 : a.compatibilityStatus === 'FAIL' ? -1 : 1));

  for (const r of issues) {
    const row = sheet.addRow([
      r.device,
      r.browser,
      r.resolution,
      r.category,
      r.compatibilityStatus,
      r.compatibilityIssueType,
      r.compatibilityIssueDescription,
      r.screenshotDir,
    ]);
    styleStatusCell(row.getCell(5), r.compatibilityStatus);
    row.getCell(8).font = { underline: true, color: { argb: 'FF0563C1' } };
  }

  sheet.columns.forEach((col, idx) => {
    const header = headers[idx] ?? '';
    const maxContentLength = Math.max(
      header.length,
      ...issues.map(
        (r) =>
          String(
            [r.device, r.browser, r.resolution, r.category, r.compatibilityStatus, r.compatibilityIssueType, r.compatibilityIssueDescription, r.screenshotDir][idx] ?? ''
          ).length
      )
    );
    col.width = Math.min(Math.max(maxContentLength + 2, 12), 70);
  });
}

export async function generateDeviceOrderExcelReport(results: DeviceOrderResult[], outputPath: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Playwright Device Order Suite';
  workbook.created = new Date();

  buildSummarySheet(workbook, results);
  buildOrderFailuresSheet(workbook, results);
  buildCompatibilityIssuesSheet(workbook, results);

  await workbook.xlsx.writeFile(outputPath);
}
