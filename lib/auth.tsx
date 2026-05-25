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
  /** True while the active session is a recovery session (set new password flow). */
  isResettingPassword: boolean;
  createProfileWithPassword: (email: string, password: string, username: string) => Promise<VerifySignupResult>;
  verifySignupCode: (email: string, code: string, username: string) => Promise<VerifySignupResult>;
  resendSignupCode: (email: string) => Promise<AuthResult>;
  sendSignInCode: (email: string) => Promise<AuthResult>;
  verifySignInCode: (email: string, code: string) => Promise<VerifySignupResult>;
  signInWithPassword: (email: string, password: string) => Promise<AuthResult>;
  /** Send a verification code to the email for password reset. Neutral on unknown emails. */
  sendPasswordResetCode: (email: string) => Promise<AuthResult>;
  /** Verify the password-reset code; on success, opens a recovery session. */
  verifyPasswordResetCode: (email: string, code: string) => Promise<VerifySignupResult>;
  /** Set a new password for the currently signed-in (or recovery-session) user. */
  updatePassword: (newPassword: string) => Promise<AuthResult>;
  /** Update the signed-in user's username in the profiles table. */
  updateUsername: (newUsername: string) => Promise<AuthResult>;
  refreshSession: () => Promise<Session | null>;
  signOut: () => Promise<AuthResult>;
  clearLocalSession: () => Promise<void>;
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
  // True between PASSWORD_RECOVERY and the next SIGNED_OUT. Lets the AuthGate
  // keep the user on /auth long enough to enter a new password.
  const [isResettingPassword, setIsResettingPassword] = useState(false);

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
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      // PASSWORD_RECOVERY fires when verifyOtp({type:'recovery'}) succeeds.
      // SIGNED_OUT clears the flag so subsequent sign-ins behave normally.
      if (event === 'PASSWORD_RECOVERY') setIsResettingPassword(true);
      else if (event === 'SIGNED_OUT') setIsResettingPassword(false);
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

  /**
   * Forgot Password, step 1: ask Supabase to send a verification code by email.
   * Supabase intentionally does not error on unknown emails — callers should
   * show the same neutral "if an account exists for this email" message
   * regardless of the result, so this never reveals account existence.
   */
  const sendPasswordResetCode = useCallback(async (email: string): Promise<AuthResult> => {
    if (supabaseConfigError) return { error: supabaseConfigError };
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase());
    return { error: error?.message ?? null };
  }, []);

  /**
   * Forgot Password, step 2: verify the code. Success creates a recovery
   * session — PASSWORD_RECOVERY fires from onAuthStateChange and sets
   * isResettingPassword so the AuthGate keeps the user on /auth.
   */
  const verifyPasswordResetCode = useCallback(
    async (email: string, code: string): Promise<VerifySignupResult> => {
      if (supabaseConfigError) return { error: supabaseConfigError, session: null };
      const { data, error } = await supabase.auth.verifyOtp({
        email: email.trim().toLowerCase(),
        token: code.trim(),
        type: 'recovery',
      });
      if (error) {
        const m = error.message.toLowerCase();
        if (m.includes('expired') || m.includes('invalid') || m.includes('token')) {
          return { error: 'Invalid or expired code. Please request a new code.', session: null };
        }
        return { error: error.message, session: null };
      }
      if (!data.session) {
        return { error: 'Verification succeeded, but no session was created. Please try again.', session: null };
      }
      setIsResettingPassword(true);
      await applySessionState(data.session);
      return { error: null, session: data.session };
    },
    [applySessionState],
  );

  /** Forgot Password, step 3: set the new password on the current Supabase user. */
  const updatePassword = useCallback(async (newPassword: string): Promise<AuthResult> => {
    if (supabaseConfigError) return { error: supabaseConfigError };
    if (!newPassword || newPassword.length < 8) {
      return { error: 'Password must be at least 8 characters.' };
    }
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (!error) setIsResettingPassword(false);
    return { error: error?.message ?? null };
  }, []);

  /** Update the signed-in user's username. Honors profiles.username unique index. */
  const updateUsername = useCallback(
    async (newUsername: string): Promise<AuthResult> => {
      if (supabaseConfigError) return { error: supabaseConfigError };
      if (!user) return { error: 'You are not signed in.' };
      const trimmed = newUsername.trim();
      if (!trimmed) return { error: 'Username cannot be empty.' };
      if (trimmed.length < 2 || trimmed.length > 64) {
        return { error: 'Username must be 2–64 characters.' };
      }

      const updateWithTimestamp = await supabase
        .from('profiles')
        .update({ username: trimmed, updated_at: new Date().toISOString() })
        .eq('id', user.id);

      let error = updateWithTimestamp.error;
      if (error && /updated_at/i.test(error.message)) {
        const updateWithoutTimestamp = await supabase
          .from('profiles')
          .update({ username: trimmed })
          .eq('id', user.id);
        error = updateWithoutTimestamp.error;
      }

      if (error) {
        const code = (error as { code?: string }).code;
        const m = error.message.toLowerCase();
        if (code === '23505' || m.includes('duplicate') || m.includes('unique')) {
          return { error: 'This username is already taken. Please choose a different one.' };
        }
        return { error: error.message };
      }
      setUsername(trimmed);
      return { error: null };
    },
    [user],
  );

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

  const clearLocalSession = useCallback(async (): Promise<void> => {
    await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
    await applySessionState(null);
  }, [applySessionState]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      session,
      loading,
      username,
      isResettingPassword,
      createProfileWithPassword,
      verifySignupCode,
      resendSignupCode,
      sendSignInCode,
      verifySignInCode,
      signInWithPassword,
      sendPasswordResetCode,
      verifyPasswordResetCode,
      updatePassword,
      updateUsername,
      refreshSession,
      signOut,
      clearLocalSession,
    }),
    [
      user,
      session,
      loading,
      username,
      isResettingPassword,
      createProfileWithPassword,
      verifySignupCode,
      resendSignupCode,
      sendSignInCode,
      verifySignInCode,
      signInWithPassword,
      sendPasswordResetCode,
      verifyPasswordResetCode,
      updatePassword,
      updateUsername,
      refreshSession,
      signOut,
      clearLocalSession,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
