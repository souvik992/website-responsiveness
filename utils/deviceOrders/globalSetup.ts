import { clearResults } from './resultsStore';

/**
 * Runs once, before any worker starts. Cheap no-op fs write for test runs
 * that don't include the device-order suite; globalTeardown only builds the
 * Excel report if any result files actually got written this run. Mirrors
 * dumdurrust-playwright's utils/responsive/globalSetup.ts.
 */
export default async function globalSetup(): Promise<void> {
  clearResults();
}
