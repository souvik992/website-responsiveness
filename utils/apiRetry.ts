import type { ApiCall } from '../fixtures/errorMonitor';

/**
 * Repeats `action` (a UI interaction, e.g. clicking "Send OTP") until the API
 * call it triggers comes back successfully, up to `maxAttempts` times.
 *
 * The staging backend this suite runs against occasionally returns an error
 * (or times out) on the first hit after being idle. Retrying the *user
 * action* — not just the request — reproduces what a real user would do,
 * and in practice "wakes up" the API for the next attempt.
 */
export async function retryUntilApiSucceeds(options: {
  apiCalls: ApiCall[];
  /** Short, human-readable name for the action, used in log lines. */
  label: string;
  /** Identifies the API call that `action` is expected to trigger. */
  matchesApi: (call: ApiCall) => boolean;
  /** Performs the UI interaction that should trigger a matching API call. */
  action: () => Promise<void>;
  maxAttempts?: number;
  /** How long to wait for the matching API call after each attempt. */
  perAttemptTimeoutMs?: number;
}): Promise<ApiCall> {
  const {
    apiCalls,
    label,
    matchesApi,
    action,
    maxAttempts = 5,
    perAttemptTimeoutMs = 15_000,
  } = options;

  let lastFailedCall: ApiCall | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const callsBeforeThisAttempt = apiCalls.length;
    await action();

    const call = await waitForNewApiCall(apiCalls, callsBeforeThisAttempt, matchesApi, perAttemptTimeoutMs);

    if (call && call.status < 400) {
      if (attempt > 1) {
        console.log(`[api-retry] "${label}" succeeded on attempt ${attempt}/${maxAttempts}.`);
      }
      return call;
    }

    lastFailedCall = call;
    const reason = call ? `status ${call.status} from ${call.url}` : 'no response received in time';
    console.warn(`[api-retry] "${label}" attempt ${attempt}/${maxAttempts} failed (${reason}).`);
  }

  throw new Error(
    `"${label}" kept failing after ${maxAttempts} attempts.` +
      (lastFailedCall ? ` Last response: ${lastFailedCall.status} ${lastFailedCall.url}` : ' No matching API call was ever observed.')
  );
}

/** Polls the shared `apiCalls` list for a call matching `matches` that arrived after `startIndex`. */
async function waitForNewApiCall(
  apiCalls: ApiCall[],
  startIndex: number,
  matches: (call: ApiCall) => boolean,
  timeoutMs: number
): Promise<ApiCall | undefined> {
  const deadline = Date.now() + timeoutMs;

  do {
    const found = apiCalls.slice(startIndex).find(matches);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 150));
  } while (Date.now() < deadline);

  return apiCalls.slice(startIndex).find(matches);
}
