import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';

import { useAuth } from './auth';
import { subscriptionReconciliation } from './subscriptionReconciliation';
import { subscriptionService } from './subscriptions';

/** Mounted once at the app root; screens only request the same shared flight. */
export function useSubscriptionReconciliation() {
  const { session, user, isGuest, loading } = useAuth();
  const token = loading ? null : session?.access_token ?? null;
  const account = loading ? null : user?.id ?? null;
  const guest = !loading && isGuest;
  subscriptionReconciliation.setSession(token, account, guest);

  useEffect(() => {
    subscriptionReconciliation.setSession(token, account, guest);
    if (Platform.OS === 'ios') void subscriptionReconciliation.request('auth_session');
  }, [token, account, guest]);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let previous = AppState.currentState;
    subscriptionReconciliation.setForeground(previous === 'active');
    const listener = AppState.addEventListener('change', (next) => {
      const returning = previous !== 'active' && next === 'active';
      previous = next;
      subscriptionReconciliation.setForeground(next === 'active');
      if (returning) void subscriptionReconciliation.request('foreground');
    });
    return () => {
      listener.remove();
      subscriptionReconciliation.dispose();
      subscriptionService.cleanup();
    };
  }, []);
}
