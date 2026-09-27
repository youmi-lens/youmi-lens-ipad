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
