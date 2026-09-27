/**
 * Generic "best-effort, never blocks the caller" wrapper. Pure — no native or
 * RN imports — so it can run and be unit-tested directly under plain Node.
 *
 * Used for operations whose outcome doesn't gate a terminal UI state (e.g.
 * telling StoreKit a transaction is finished, after the backend has already
 * granted/rejected the purchase): the caller must be able to reach a terminal
 * state even if the underlying task hangs or fails.
 */
export function boundedVoidTask(
  task: () => Promise<void>,
  timeoutMs: number,
  onTimeout: () => void,
  onError?: (error: unknown) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout();
      resolve();
    }, timeoutMs);
    Promise.resolve().then(task)
      .catch((error) => {
        onError?.(error);
      })
      .finally(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
  });
}
