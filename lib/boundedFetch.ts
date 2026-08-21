/**
 * Single bounded-fetch helper for the subscription / account-plan workflow.
 *
 * Guarantees no backend network stage can leave the Subscribe UI spinning
 * unbounded: every fetch aborts after a fixed window and rejects with a
 * recognizable timeout error, so the caller's `finally` (which clears the
 * spinner) is always reachable.
 *
 * Never logs or carries secrets; it only aborts and re-types the timeout.
 */

/** One shared bound for subscription/entitlement network calls. */
export const SUBSCRIPTION_FETCH_TIMEOUT_MS = 25_000;

/** Typed, recognizable timeout so callers can distinguish "timed out" from "offline". */
export class BoundedFetchTimeoutError extends Error {
  readonly stage: string;

  constructor(stage: string) {
    super(`Network request timed out (${stage}).`);
    this.name = 'BoundedFetchTimeoutError';
    this.stage = stage;
  }
}

export function isBoundedFetchTimeout(error: unknown): error is BoundedFetchTimeoutError {
  return (
    error instanceof BoundedFetchTimeoutError ||
    (error instanceof Error && error.name === 'BoundedFetchTimeoutError')
  );
}

/**
 * `fetch` with a hard AbortController deadline. On timeout the in-flight request
 * is aborted and a `BoundedFetchTimeoutError` is thrown; any other fetch failure
 * passes through unchanged.
 */
export async function boundedFetch(
  input: string,
  init?: RequestInit,
  timeoutMs: number = SUBSCRIPTION_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new BoundedFetchTimeoutError(input);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
