import AsyncStorage from '@react-native-async-storage/async-storage';
import type { EmailOtpType, Session, User } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import { supabase, supabaseConfigError } from './supabase';

export const AUTH_CALLBACK_URL = 'youmilens://auth/callback';

const PENDING_USERNAME_KEY = 'youmi.pendingUsername.v1';
const EMAIL_OTP_TYPES = new Set<EmailOtpType>([
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
  'email',
]);

type AuthResult = {
  error: string | null;
};

type VerifySignupResult = AuthResult & {
  session: Session | null;
};

type AuthContextValue = {
  user: User | null;
  session: Session | null;
  loading: boolean;
  username: string | null;
  sendSignupCode: (email: string) => Promise<AuthResult>;
  verifySignupCodeAndSetPassword: (
    email: string,
    code: string,
    username: string,
    password: string,
    createProfileStartedAt: number,
  ) => Promise<VerifySignupResult>;
  signInWithPassword: (email: string, password: string) => Promise<AuthResult>;
  savePendingUsername: (username: string) => Promise<void>;
  clearPendingUsername: () => Promise<void>;
  refreshSession: () => Promise<Session | null>;
  signOut: () => Promise<AuthResult>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function getCallbackParams(url: string): URLSearchParams | null {
  try {
    const parsed = new URL(url);
    if (parsed.host !== 'auth' || parsed.pathname !== '/callback') return null;

    const params = new URLSearchParams();
    if (parsed.hash) {
      new URLSearchParams(parsed.hash.slice(1)).forEach((value, key) => params.set(key, value));
    }
    parsed.searchParams.forEach((value, key) => params.set(key, value));
    return params;
  } catch {
    return null;
  }
}

export async function applySessionFromCallbackUrl(url: string): Promise<Session | null> {
  const params = getCallbackParams(url);
  if (!params) return null;

  const errorDescription = params.get('error_description') ?? params.get('error');
  if (errorDescription) return null;

  const tokenHash = params.get('token_hash');
  const type = params.get('type') as EmailOtpType | null;
  if (tokenHash && type && EMAIL_OTP_TYPES.has(type)) {
    const { data } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    return data.session;
  }

  const email = params.get('email');
  const token = params.get('token');
  if (email && token && type && EMAIL_OTP_TYPES.has(type)) {
    const { data } = await supabase.auth.verifyOtp({ email, token, type });
    return data.session;
  }

  const code = params.get('code');
  if (code) {
    const { data } = await supabase.auth.exchangeCodeForSession(code);
    return data.session;
  }

  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (accessToken && refreshToken) {
    const { data } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    return data.session;
  }

  return null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadUsername = useCallback(async (nextUser: User | null) => {
    if (!nextUser) {
      setUsername(null);
      return;
    }

    const metadataUsername =
      typeof nextUser.user_metadata?.username === 'string' ? nextUser.user_metadata.username : null;

    const { data, error } = await supabase
      .from('profiles')
      .select('username')
      .eq('id', nextUser.id)
      .maybeSingle();

    if (error) {
      console.warn('[auth] unable to load profile username', error.message);
      setUsername(metadataUsername);
      return;
    }

    setUsername(data?.username ?? metadataUsername);
  }, []);

  const applySessionState = useCallback(
    async (nextSession: Session | null) => {
      setSession(nextSession);
      setUser(nextSession?.user ?? null);
      await loadUsername(nextSession?.user ?? null);
    },
    [loadUsername],
  );

  useEffect(() => {
    let mounted = true;

    supabase.auth
      .getSession()
      .then(async ({ data, error }) => {
        if (!mounted) return;
        await applySessionState(error ? null : data.session);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      void applySessionState(nextSession);
      setLoading(false);
    });

    const handleAuthCallbackUrl = async (url: string | null) => {
      if (!url || supabaseConfigError) return;
      await applySessionFromCallbackUrl(url);
    };

    Linking.getInitialURL().then(handleAuthCallbackUrl);
    const linkSubscription = Linking.addEventListener('url', ({ url }) => {
      handleAuthCallbackUrl(url);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
      linkSubscription.remove();
    };
  }, [applySessionState]);

  const savePendingUsername = useCallback(async (nextUsername: string) => {
    await AsyncStorage.setItem(PENDING_USERNAME_KEY, nextUsername);
  }, []);

  const clearPendingUsername = useCallback(async () => {
    await AsyncStorage.removeItem(PENDING_USERNAME_KEY);
  }, []);

  const upsertProfileUsername = useCallback(async (nextUser: User, nextUsername: string) => {
    const { error } = await supabase.from('profiles').upsert({
      id: nextUser.id,
      username: nextUsername,
      updated_at: new Date().toISOString(),
    });

    if (error) {
      console.warn('[auth] unable to save profile username', error.message);
      return;
    }

    setUsername(nextUsername);
  }, []);

  const sendSignupCode = useCallback(async (email: string): Promise<AuthResult> => {
    if (supabaseConfigError) return { error: supabaseConfigError };

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
      },
    });

    return { error: error?.message ?? null };
  }, []);

  const verifySignupCodeAndSetPassword = useCallback(
    async (
      email: string,
      code: string,
      nextUsername: string,
      password: string,
      createProfileStartedAt: number,
    ): Promise<VerifySignupResult> => {
      if (supabaseConfigError) return { error: supabaseConfigError, session: null };

      const { data: otpData, error: otpError } = await supabase.auth.verifyOtp({
        email,
        token: code,
        type: 'email',
      });

      if (otpError) return { error: otpError.message, session: null };
      if (!otpData.session || !otpData.user) {
        return { error: 'Verification succeeded, but no session was created. Please try again.', session: null };
      }

      const createdAtMillis = otpData.user.created_at ? Date.parse(otpData.user.created_at) : Number.NaN;
      const clearlyExistingAccount =
        Number.isFinite(createdAtMillis) && createdAtMillis < createProfileStartedAt - 60_000;

      if (!Number.isFinite(createdAtMillis)) {
        console.warn('[auth] verified user missing created_at during create-profile flow');
      }

      const metadataUsername =
        typeof otpData.user.user_metadata?.username === 'string' ? otpData.user.user_metadata.username : null;
      let existingProfileUsername: string | null = null;
      if (!Number.isFinite(createdAtMillis)) {
        const { data: existingProfile, error: existingProfileError } = await supabase
          .from('profiles')
          .select('username')
          .eq('id', otpData.user.id)
          .maybeSingle();
        if (existingProfileError) {
          console.warn('[auth] unable to inspect profile during create-profile flow', existingProfileError.message);
        } else {
          existingProfileUsername = existingProfile?.username ?? null;
        }
      }

      if (clearlyExistingAccount || (!Number.isFinite(createdAtMillis) && Boolean(metadataUsername || existingProfileUsername))) {
        await supabase.auth.signOut();
        await clearPendingUsername();
        await applySessionState(null);
        return {
          error: 'This email already has a Youmi Lens account. Please sign in instead.',
          session: null,
        };
      }

      const { data: updateData, error: updateError } = await supabase.auth.updateUser({
        password,
        data: { username: nextUsername },
      });

      if (updateError) {
        return {
          error: `Your email was verified, but we could not set your password: ${updateError.message}`,
          session: otpData.session,
        };
      }

      const updatedUser = updateData.user ?? otpData.user;
      setUsername(nextUsername);
      await upsertProfileUsername(updatedUser, nextUsername);
      await clearPendingUsername();
      await applySessionState(otpData.session);

      return { error: null, session: otpData.session };
    },
    [applySessionState, clearPendingUsername, upsertProfileUsername],
  );

  const signInWithPassword = useCallback(async (email: string, password: string): Promise<AuthResult> => {
    if (supabaseConfigError) return { error: supabaseConfigError };

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (!error) return { error: null };

    if (error.message.toLowerCase().includes('invalid login credentials')) {
      return {
        error:
          'Invalid email or password. If this account was created with an older magic-link-only flow and has no password, contact support for account recovery.',
      };
    }

    return { error: error.message };
  }, []);

  const refreshSession = useCallback(async (): Promise<Session | null> => {
    const { data } = await supabase.auth.getSession();
    await applySessionState(data.session);
    return data.session;
  }, [applySessionState]);

  const signOut = useCallback(async (): Promise<AuthResult> => {
    const { error } = await supabase.auth.signOut();
    return { error: error?.message ?? null };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      session,
      loading,
      username,
      sendSignupCode,
      verifySignupCodeAndSetPassword,
      signInWithPassword,
      savePendingUsername,
      clearPendingUsername,
      refreshSession,
      signOut,
    }),
    [
      user,
      session,
      loading,
      username,
      sendSignupCode,
      verifySignupCodeAndSetPassword,
      signInWithPassword,
      savePendingUsername,
      clearPendingUsername,
      refreshSession,
      signOut,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
