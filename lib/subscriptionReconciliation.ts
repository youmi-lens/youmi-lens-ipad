import { BillingRequestIdentity } from './billingRequestIdentity';
import { boundedPaymentTask, PAYMENT_UI_WAIT_TIMEOUT_MS } from './boundedPaymentTask';
import { guestIapSupabase, isGuestIapClientConfigured } from './guestIapClient';
import { subscriptionService, type SubscriptionRestoreResult } from './subscriptions';

type Credentials = { accessToken: string; accountId: string };
type Trigger = 'auth_session' | 'foreground' | 'plans_mount';
type AccessChange = { subject: string };
type ReconciliationService = Pick<typeof subscriptionService, 'reconcileSilently' | 'getEntitlement'>;

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
  private flight: Promise<SubscriptionRestoreResult | null> | null = null;
  private flightTicket: ReturnType<BillingRequestIdentity['begin']> | null = null;
  private queued = false;
  private listeners = new Set<(change: AccessChange) => void>();

  constructor(private service: ReconciliationService,
    private readGuestCredentials: () => Promise<Credentials | null> = existingGuestCredentials) {}

  // Called during the root render, like the existing screen guards: invalidate A before B's effects run.
  setSession(accessToken: string | null, accountId: string | null, guest = false) {
    this.identity.setIdentity(guest ? 'guest' : accessToken && accountId ? accountId : null);
    this.guest = guest;
    this.credentials = !guest && accessToken && accountId ? { accessToken, accountId } : null;
  }

  subscribe(listener: (change: AccessChange) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  request(_trigger: Trigger): Promise<SubscriptionRestoreResult | null> {
    if (!this.credentials && !this.guest) return Promise.resolve(null);
    if (this.flight) {
      // Same-account lifecycle triggers collapse. A new account waits for the old flight to release its lock.
      if (this.flightTicket && !this.identity.owns(this.flightTicket)) this.queued = true;
      return this.flight;
    }
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
        if (['success', 'expired', 'revoked', 'no_purchase'].includes(outcome.code) ||
          outcome.outcomes?.some(item => item.granted === true && item.safeToFinish === true)) {
          const access = await this.service.getEntitlement(credentials.accessToken);
          if (access?.ok && current() && ticket.identity) {
            for (const listener of this.listeners) listener({ subject: ticket.identity });
          }
        }
        return current() ? outcome : null;
      } catch {
        // No Restore alert, retry timer, or discarded StoreKit transaction. Next lifecycle trigger retries.
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
