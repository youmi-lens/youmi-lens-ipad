import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

/** True when both Supabase env vars are present and the client can authenticate. */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

// User-facing string when Supabase env is missing. In development we surface the
// exact missing-variable instructions to speed debugging; in a production /
// TestFlight build we must never show developer `.env` instructions, so we fall
// back to a calm, user-safe message.
export const supabaseConfigError = isSupabaseConfigured
  ? null
  : __DEV__
    ? 'Missing Supabase environment variables. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in .env.'
    : 'Sign-in is temporarily unavailable. Please try again later.';

const isServerSideWebRender = Platform.OS === 'web' && typeof window === 'undefined';

const serverStorage = {
  getItem: async (_key: string) => null,
  setItem: async (_key: string, _value: string) => {},
  removeItem: async (_key: string) => {},
};

export const supabase = createClient(
  supabaseUrl ?? 'https://missing-project.supabase.co',
  supabaseAnonKey ?? 'missing-anon-public-key',
  {
    auth: {
      storage: isServerSideWebRender ? serverStorage : AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  },
);
