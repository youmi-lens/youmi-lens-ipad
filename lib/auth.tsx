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
  createProfileWithPassword: (email: string, password: string, username: string) => Promise<VerifySignupResult>;
  verifySignupCode: (email: string, code: string, username: string) => Promise<VerifySignupResult>;
  resendSignupCode: (email: string) => Promise<AuthResult>;
  sendSignInCode: (email: string) => Promise<AuthResult>;
  verifySignInCode: (email: string, code: string) => Promise<VerifySignupResult>;
  signInWithPassword: (email: string, password: string) => Promise<AuthResult>;
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

  // Create Profile, step 1: Supabase signUp. With email confirmation enabled,
  // Supabase emails a verification code (Confirm sign up template → {{ .Token }})
  // and returns no session — the code is verified in step 2.
  const createProfileWithPassword = useCallback(
    async (email: string, password: string, nextUsername: string): Promise<VerifySignupResult> => {
      if (supabaseConfigError) return { error: supabaseConfigError, session: null };

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { username: nextUsername } },
      });

      if (error) {
        if (error.message.toLowerCase().includes('already registered')) {
          return {
            error: 'This email already has a Youmi Lens account. Please sign in or use an email verification code.',
            session: null,
          };
        }
        return { error: error.message, session: null };
      }
      if (!data.user) {
        return { error: 'We could not create your account. Please try again.', session: null };
      }

      // If email confirmation is disabled, signUp returns a session immediately.
      if (data.session) {
        await upsertProfileUsername(data.user, nextUsername);
        await applySessionState(data.session);
      }
      return { error: null, session: data.session };
    },
    [applySessionState, upsertProfileUsername],
  );

  // Create Profile, step 2: verify the Supabase signup confirmation code.
  const verifySignupCode = useCallback(
    async (email: string, code: string, nextUsername: string): Promise<VerifySignupResult> => {
      if (supabaseConfigError) return { error: supabaseConfigError, session: null };

      const { data, error } = await supabase.auth.verifyOtp({
        email,
        token: code,
        type: 'signup',
      });

      if (error) {
        const normalized = error.message.toLowerCase();
        if (
          normalized.includes('expired') ||
          normalized.includes('invalid') ||
          normalized.includes('token')
        ) {
          return { error: 'Invalid or expired code. Please try again or resend a new code.', session: null };
        }
        return { error: error.message, session: null };
      }
      if (!data.session || !data.user) {
        return { error: 'Verification succeeded, but no session was created. Please try again.', session: null };
      }

      await upsertProfileUsername(data.user, nextUsername);
      await applySessionState(data.session);
      return { error: null, session: data.session };
    },
    [applySessionState, upsertProfileUsername],
  );

  /** Re-send the Supabase signup confirmation email (carries a fresh code). */
  const resendSignupCode = useCallback(async (email: string): Promise<AuthResult> => {
    if (supabaseConfigError) return { error: supabaseConfigError };
    const { error } = await supabase.auth.resend({ type: 'signup', email });
    return { error: error?.message ?? null };
  }, []);

  const sendSignInCode = useCallback(async (email: string): Promise<AuthResult> => {
    if (supabaseConfigError) return { error: supabaseConfigError };

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
      },
    });

    if (error) {
      const normalizedMessage = error.message.toLowerCase();
      if (
        normalizedMessage.includes('signup') ||
        normalizedMessage.includes('user not found') ||
        normalizedMessage.includes('not found')
      ) {
        return { error: 'No account found for this email. Please create a profile first.' };
      }
    }

    return { error: error?.message ?? null };
  }, []);

  const verifySignInCode = useCallback(async (email: string, code: string): Promise<VerifySignupResult> => {
    if (supabaseConfigError) return { error: supabaseConfigError, session: null };

    const { data, error } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: 'email',
    });

    if (error) {
      const normalizedMessage = error.message.toLowerCase();
      if (
        normalizedMessage.includes('expired') ||
        normalizedMessage.includes('invalid') ||
        normalizedMessage.includes('token')
      ) {
        return { error: 'Invalid or expired code. Please try again or resend a new code.', session: null };
      }
      return { error: error.message, session: null };
    }
    if (!data.session) {
      return { error: 'Verification succeeded, but no session was created. Please try again.', session: null };
    }

    await applySessionState(data.session);
    return { error: null, session: data.session };
  }, [applySessionState]);

  const signInWithPassword = useCallback(async (email: string, password: string): Promise<AuthResult> => {
    if (supabaseConfigError) return { error: supabaseConfigError };

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (!error) return { error: null };

    if (error.message.toLowerCase().includes('invalid login credentials')) {
      return {
        error:
          'Invalid email or password. If you forgot your password or created your account without one, use an email verification code.',
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
    if (!error) await applySessionState(null);
    return { error: error?.message ?? null };
  }, [applySessionState]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      session,
      loading,
      username,
      createProfileWithPassword,
      verifySignupCode,
      resendSignupCode,
      sendSignInCode,
      verifySignInCode,
      signInWithPassword,
      refreshSession,
      signOut,
    }),
    [
      user,
      session,
      loading,
      username,
      createProfileWithPassword,
      verifySignupCode,
      resendSignupCode,
      sendSignInCode,
      verifySignInCode,
      signInWithPassword,
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
