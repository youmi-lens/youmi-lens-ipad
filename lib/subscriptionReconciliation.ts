import { BillingRequestIdentity } from './billingRequestIdentity';
import { boundedPaymentTask, PAYMENT_UI_WAIT_TIMEOUT_MS } from './boundedPaymentTask';
import { guestIapSupabase, isGuestIapClientConfigured } from './guestIapClient';
import { subscriptionService, type SubscriptionRestoreResult } from './subscriptions';

/** Retry schedule for one reconciliation episode. */
export const RETRY_DELAYS_MS = [5000, 15000, 30000, 60000, 120000, 300000] as const;
type Credentials = { accessToken: string; accountId: string };
type Trigger = 'auth_session' | 'foreground' | 'plans_mount' | 'activation_pending' | 'retry';
type AccessChange = { subject: string };
type ReconciliationService = Pick<typeof subscriptionService, 'reconcileSilently' | 'getEntitlement'> &
  Partial<Pick<typeof subscriptionService, 'subscribeActivationPending'>>;

// Read only: automatic recovery must never create a guest account or change the main session.
async function existingGuestCredentials(): Promise<Credentials | null> {
  if (!isGuestIapClientConfigured) return null;
  const { data } = await guestIapSupabase.auth.getSession();
  const session = data.session;
  return session?.access_token && session.user?.id
    ? { accessToken: session.access_token, accountId: session.user.id } : null;
}

/** One app-wide flight. StoreKit history is the durable queue, not an in-memory transaction cache. */
export class SubscriptionReconciliation {
  private identity = new BillingRequestIdentity();
  private credentials: Credentials | null = null;
  private guest = false;
  private sessionIdentity: string | null = null;
  private flight: Promise<SubscriptionRestoreResult | null> | null = null;
  private flightTicket: ReturnType<BillingRequestIdentity['begin']> | null = null;
  private queued = false;
  private listeners = new Set<(change: AccessChange) => void>();

  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryStep = 0;
  private foreground = true;
  private pendingDelivery = false;

  private clearRetry() {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private scheduleRetry() {
    if (!this.foreground || this.retryTimer !== null || (!this.credentials && !this.guest)) return;
    // Bounded episode: ~8.5 minutes of foreground retries, then rest until a new lifecycle trigger
    // (foreground return, Plans, sign-in) starts a fresh episode. Never an unbounded loop.
    if (this.retryStep >= RETRY_DELAYS_MS.length) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.request('retry');
    }, RETRY_DELAYS_MS[this.retryStep++]);
  }

  setForeground(active: boolean) {
    this.foreground = active;
    if (!active) this.clearRetry();
  }

  constructor(private service: ReconciliationService,
    private readGuestCredentials: () => Promise<Credentials | null> = existingGuestCredentials) {
    service.subscribeActivationPending?.(() => { this.pendingDelivery = true; if (this.flight) this.queued = true; void this.request('activation_pending'); });
  }

  // Called during the root render, like the existing screen guards: invalidate A before B's effects run.
  setSession(accessToken: string | null, accountId: string | null, guest = false) {
    const nextIdentity = guest ? 'guest' : accessToken && accountId ? accountId : null;
    if (nextIdentity !== this.sessionIdentity) { this.clearRetry(); this.retryStep = 0; this.pendingDelivery = false; }
    this.sessionIdentity = nextIdentity;
    this.identity.setIdentity(nextIdentity);
    this.guest = guest;
    this.credentials = !guest && accessToken && accountId ? { accessToken, accountId } : null;
  }

  subscribe(listener: (change: AccessChange) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  request(trigger: Trigger): Promise<SubscriptionRestoreResult | null> {
    if (!this.credentials && !this.guest) return Promise.resolve(null);
    // A genuinely new trigger starts a fresh bounded episode; the timer's own 'retry' continues the current one.
    if (trigger !== 'retry') this.retryStep = 0;
    if (this.flight) {
      // Same-account lifecycle triggers collapse. A new account waits for the old flight to release its lock.
      if (this.flightTicket && !this.identity.owns(this.flightTicket)) this.queued = true;
      return this.flight;
    }
    this.clearRetry();
    const ticket = this.identity.begin();
    this.flightTicket = ticket;
    const capturedCredentials = this.credentials;
    const current = () => this.identity.owns(ticket);
    const run = async () => {
      try {
        const credentials = capturedCredentials ?? await boundedPaymentTask(
          this.readGuestCredentials, PAYMENT_UI_WAIT_TIMEOUT_MS, 'reconciliation_identity');
        if (!credentials || !current()) return null;
        const outcome = await this.service.reconcileSilently(credentials.accessToken, credentials.accountId, current);
        if (!current()) return null;
        // Read fresh backend access, including expiry/revocation. No optimistic local grant.
        let accessReadFailed = false;
        if (['success', 'expired', 'revoked', 'no_purchase'].includes(outcome.code) ||
          outcome.outcomes?.some(item => item.granted === true && item.safeToFinish === true)) {
          const access = await this.service.getEntitlement(credentials.accessToken);
          accessReadFailed = !access?.ok;
          if (access?.ok && current() && ticket.identity) {
            for (const listener of this.listeners) listener({ subject: ticket.identity });
          }
        }
        if (current()) {
          if (outcome.retryable !== false && (outcome.finishPending || accessReadFailed || ['offline', 'verify_timeout', 'backend_verification_failed', 'storekit_error', 'operation_timeout', 'purchase_in_progress'].includes(outcome.code) ||
              outcome.outcomes?.some(item => item.retryable) || (this.pendingDelivery && outcome.code === 'no_purchase'))) this.scheduleRetry();
          else { this.retryStep = 0; this.pendingDelivery = false; }
        }
        return current() ? outcome : null;
      } catch {
        // StoreKit remains the durable queue. Retry while foreground, without sync or alerts.
        if (current()) this.scheduleRetry();
        return null;
      }
    };
    // Defer the body until the flight is installed; synchronous callbacks cannot start another flight.
    const flight = Promise.resolve().then(run).finally(() => {
      if (this.flight !== flight) return;
      this.flight = null;
      this.flightTicket = null;
      if (this.queued) {
        this.queued = false;
        void this.request('auth_session');
      }
    });
    this.flight = flight;
    return flight;
  }

  dispose() {
    this.setSession(null, null);
    this.queued = false;
  }
}

export const subscriptionReconciliation = new SubscriptionReconciliation(subscriptionService);
