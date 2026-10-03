/** Bounds the application's wait without claiming to cancel native StoreKit work.
 * Late completion cannot resolve the caller after the deadline. Use for setup,
 * queries and UI refreshes, never a short deadline for the Apple purchase sheet.
 */
export class PaymentTaskTimeoutError extends Error {
  constructor(readonly stage: string) {
    super('The payment operation took too long. Please try again.');
    this.name = 'PaymentTaskTimeoutError';
  }
}

export const PAYMENT_UI_WAIT_TIMEOUT_MS = 25_000;

export function boundedPaymentTask<T>(
  task: () => Promise<T>, timeoutMs: number, stage: string,
  timeoutError: () => Error = () => new PaymentTaskTimeoutError(stage),
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError()), timeoutMs);
    Promise.resolve().then(task).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** The slice of react-native's AppState this module needs. Injected, so this file stays free of native imports. */
export type ActiveStateSource = {
  currentState: string;
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
};

/**
 * Like `boundedPaymentTask`, for a StoreKit call that can wait on the person (Apple's sign-in UI). Only time the app is
 * `active` counts against `activeBudgetMs`: iOS reports `inactive` behind a system alert and `background` once the
 * person has gone to Settings, and JS timers cannot be trusted across suspension. `backstopMs` is a finite wall-clock
 * limit so the caller can never wait forever. Like its sibling it cannot cancel native work; a late completion after
 * the deadline is ignored.
 */
export function boundedActiveTimeTask<T>(
  task: () => Promise<T>, activeBudgetMs: number, backstopMs: number, stage: string, appState: ActiveStateSource,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let remaining = activeBudgetMs;
    let activeSince: number | null = null;
    let activeTimer: ReturnType<typeof setTimeout> | undefined;
    let subscription: { remove(): void } | undefined;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(activeTimer);
      clearTimeout(backstopTimer);
      subscription?.remove();
      settle();
    };
    const expire = () => finish(() => reject(new PaymentTaskTimeoutError(stage)));
    const resume = () => {
      if (activeSince !== null) return;
      activeSince = Date.now();
      activeTimer = setTimeout(expire, remaining);
    };
    const pause = () => {
      if (activeSince === null) return;
      clearTimeout(activeTimer);
      remaining -= Date.now() - activeSince;
      activeSince = null;
      if (remaining <= 0) expire();
    };
    const backstopTimer = setTimeout(expire, backstopMs);
    subscription = appState.addEventListener('change', (next) => {
      if (done) return;
      if (next === 'active') resume(); else pause();
    });
    if (appState.currentState === 'active') resume();
    Promise.resolve().then(task).then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
  });
}
