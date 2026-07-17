import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { TEST_CASES, TestCaseDefinition, TestSuite } from '../test-cases/testCaseDefinitions';

const RESULTS_JSON_PATH = process.argv[2] || 'test-results/results.json';
const OUTPUT_XLSX_PATH = process.argv[3] || 'test-results/test-case-report.xlsx';

type PlaywrightStatus = 'passed' | 'failed' | 'timedOut' | 'interrupted' | 'skipped';

interface JsonReporterResult {
  status: PlaywrightStatus;
  duration: number;
  error?: { message?: string };
}

interface JsonReporterSpec {
  title: string;
  tags?: string[];
  tests: { results: JsonReporterResult[] }[];
}

interface JsonReporterSuite {
  title: string;
  specs?: JsonReporterSpec[];
  suites?: JsonReporterSuite[];
}

interface JsonReporterRoot {
  suites: JsonReporterSuite[];
}

interface CaseOutcome {
  status: 'PASS' | 'FAIL' | 'NOT RUN';
  actualResult: string;
  durationSeconds: number;
}

const STATUS_FILL: Record<string, string> = {
  PASS: 'FFC6EFCE',
  FAIL: 'FFFFC7CE',
  'NOT RUN': 'FFD9D9D9',
};

const STATUS_FONT: Record<string, string> = {
  PASS: 'FF006100',
  FAIL: 'FF9C0006',
  'NOT RUN': 'FF666666',
};

const HEADERS = ['Module', 'Test Case ID', 'Title', 'Priority', 'Expected Result', 'Actual Result', 'Status', 'Duration (s)'];

/** Every spec (Playwright's JSON reporter nests suites: file suite -> describe suite -> specs). */
function collectSpecs(suite: JsonReporterSuite, out: JsonReporterSpec[]): void {
  for (const spec of suite.specs ?? []) out.push(spec);
  for (const childSuite of suite.suites ?? []) collectSpecs(childSuite, out);
}

/**
 * Tags land on `spec.tags`, not `test.tags` — confirmed live from a real
 * results.json dump, since Playwright's JSON reporter docs don't spell out
 * the exact nesting. The leading "@" from `{ tag: '@SAN-001' }` is stripped
 * by the time it reaches this array.
 */
function findOutcomeFor(specs: JsonReporterSpec[], id: string): CaseOutcome {
  const spec = specs.find((s) => (s.tags ?? []).includes(id));
  if (!spec) {
    return { status: 'NOT RUN', actualResult: 'Not run in this session.', durationSeconds: 0 };
  }

  // Last attempt/retry is the one that determines the final outcome.
  const results = spec.tests[0]?.results ?? [];
  const result = results[results.length - 1];
  if (!result) {
    return { status: 'NOT RUN', actualResult: 'Not run in this session.', durationSeconds: 0 };
  }

  const durationSeconds = Math.round(result.duration / 1000);
  if (result.status === 'passed') {
    return { status: 'PASS', actualResult: `As expected — completed in ${durationSeconds}s.`, durationSeconds };
  }
  return {
    status: 'FAIL',
    actualResult: result.error?.message?.split('\n')[0] ?? `Test ${result.status}.`,
    durationSeconds,
  };
}

function caseRow(tc: TestCaseDefinition, outcome: CaseOutcome): (string | number)[] {
  return [tc.module, tc.id, tc.title, tc.priority, tc.expectedResult, outcome.actualResult, outcome.status, outcome.durationSeconds];
}

function styleStatusCell(cell: ExcelJS.Cell, status: string) {
  if (!STATUS_FILL[status]) return;
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STATUS_FILL[status] } };
  cell.font = { color: { argb: STATUS_FONT[status] }, bold: true };
}

function buildSuiteSheet(workbook: ExcelJS.Workbook, sheetName: string, suite: TestSuite, specs: JsonReporterSpec[]) {
  const sheet = workbook.addWorksheet(sheetName);
  const cases = TEST_CASES.filter((tc) => tc.suite === suite);

  const total = cases.length;
  const outcomes = cases.map((tc) => findOutcomeFor(specs, tc.id));
  const passCount = outcomes.filter((o) => o.status === 'PASS').length;
  const failCount = outcomes.filter((o) => o.status === 'FAIL').length;
  const notRunCount = outcomes.filter((o) => o.status === 'NOT RUN').length;

  sheet.addRow([`${sheetName} — Test Case Report`]);
  sheet.getRow(1).font = { bold: true, size: 14 };
  sheet.addRow([`Total: ${total}`, `Passed: ${passCount}`, `Failed: ${failCount}`, `Not run: ${notRunCount}`]);
  sheet.getRow(2).font = { bold: true };
  sheet.addRow([]);

  const headerRowIndex = sheet.rowCount + 1;
  const headerRow = sheet.addRow(HEADERS);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
  });

  cases.forEach((tc, idx) => {
    const outcome = outcomes[idx];
    const row = sheet.addRow(caseRow(tc, outcome));
    styleStatusCell(row.getCell(HEADERS.indexOf('Status') + 1), outcome.status);
  });

  sheet.views = [{ state: 'frozen', ySplit: headerRowIndex }];
  sheet.autoFilter = { from: { row: headerRowIndex, column: 1 }, to: { row: headerRowIndex, column: HEADERS.length } };

  sheet.columns.forEach((col, idx) => {
    const header = HEADERS[idx] ?? '';
    const maxContentLength = Math.max(header.length, ...cases.map((tc, i) => String(caseRow(tc, outcomes[i])[idx] ?? '').length));
    col.width = Math.min(Math.max(maxContentLength + 2, 12), idx === HEADERS.indexOf('Title') || idx === HEADERS.indexOf('Expected Result') || idx === HEADERS.indexOf('Actual Result') ? 60 : 30);
  });
}

async function main() {
  if (!fs.existsSync(RESULTS_JSON_PATH)) {
    console.error(`No JSON reporter output found at ${RESULTS_JSON_PATH} — run the functional suite first (its reporter config writes this file).`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(RESULTS_JSON_PATH, 'utf-8')) as JsonReporterRoot;
  const specs: JsonReporterSpec[] = [];
  for (const suite of data.suites ?? []) collectSpecs(suite, specs);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Playwright Functional Test Suite';
  workbook.created = new Date();

  buildSuiteSheet(workbook, 'Sanity', 'Sanity', specs);
  buildSuiteSheet(workbook, 'End to End', 'End to End', specs);
  buildSuiteSheet(workbook, 'API Testing', 'API Testing', specs);

  fs.mkdirSync(path.dirname(OUTPUT_XLSX_PATH), { recursive: true });
  await workbook.xlsx.writeFile(OUTPUT_XLSX_PATH);
  console.log(`Wrote test-case report (${TEST_CASES.length} case(s)) to ${OUTPUT_XLSX_PATH}`);
}

main();
