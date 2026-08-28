import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';

import { assertDevNotProduction } from './envGuard.mjs';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

assertDevNotProduction({ url: supabaseUrl, key: supabaseAnonKey, isDev: __DEV__ });

/** True when this client can actually authenticate (env configured). */
export const isGuestIapClientConfigured = Boolean(supabaseUrl && supabaseAnonKey);

const isServerSideWebRender = Platform.OS === 'web' && typeof window === 'undefined';
const serverStorage = {
  getItem: async (_key: string) => null,
  setItem: async (_key: string, _value: string) => {},
  removeItem: async (_key: string) => {},
};

/**
 * App Review Guideline 5.1.1(v) — a SECOND, FULLY ISOLATED Supabase client,
 * used ONLY for anonymous/guest In-App Purchase identity: the purchase
 * verification token, the restore verification token, and (later) the
 * account-upgrade flow that keeps a guest's purchase after they choose to
 * register. It points at the exact same Supabase PROJECT as the main app
 * client (same URL/anon key — this is one project, two independent client
 * instances), but its session lives under its own storage key
 * (`GUEST_IAP_STORAGE_KEY`), completely separate from the main client's
 * default session key.
 *
 * This isolation is the whole safety property this module exists for:
 *   - lib/auth.tsx's `AuthProvider` never imports this file, so `useAuth()`'s
 *     `session` / `user` / `isGuest` can NEVER observe a guest-IAP identity.
 *   - lib/store.tsx's Cloud Library gates entirely on `useAuth()`'s `user?.id`
 *     (see `currentUserId = user?.id ?? null` there) — since that path never
 *     reads this client, an anonymous guest-IAP sign-in can NEVER trigger
 *     Cloud Library hydration, course sync, or recording upload.
 *   - Signing in anonymously here cannot overwrite, clear, or interact with
 *     the main client's persisted session in AsyncStorage in any way, because
 *     the two clients read and write disjoint storage keys.
 *
 * Do NOT import `guestIapSupabase` from AuthProvider, lib/store.tsx, or any
 * screen/hook that isn't specifically guest-purchase UI. Do NOT give it the
 * same `storageKey` as the main client.
 */
const GUEST_IAP_STORAGE_KEY = 'sb-guest-iap-auth-token';

export const guestIapSupabase = createClient(
  supabaseUrl ?? 'https://missing-project.supabase.co',
  supabaseAnonKey ?? 'missing-anon-public-key',
  {
    auth: {
      storage: isServerSideWebRender ? serverStorage : AsyncStorage,
      storageKey: GUEST_IAP_STORAGE_KEY,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  },
);
