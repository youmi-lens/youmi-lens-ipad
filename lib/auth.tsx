import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from '@react-native-google-signin/google-signin';
import type { EmailOtpType, Session, User } from '@supabase/supabase-js';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
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
import { Platform } from 'react-native';

import { GUEST_MODE_KEY } from './guest';
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
  /** True when the user chose to continue without an account (local-only guest). */
  isGuest: boolean;
  /** Enter the app without an account. Guest state is local-only on this device. */
  continueAsGuest: () => Promise<void>;
  /** Leave guest mode (e.g. when heading to the sign-in screen). */
  exitGuest: () => Promise<void>;
  /** True while the active session is a recovery session (set new password flow). */
  isResettingPassword: boolean;
  needsUsernameSetup: boolean;
  createProfileWithPassword: (email: string, password: string) => Promise<VerifySignupResult>;
  verifySignupCode: (email: string, code: string) => Promise<VerifySignupResult>;
  signInWithProvider: (provider: 'apple' | 'google') => Promise<AuthResult>;
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

// ── Native social sign-in helpers ───────────────────────────────────────────
// Client IDs are not secrets and are supplied through public env config. The
// Google *web* client secret lives only in Supabase, never in the app.
const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
const GOOGLE_IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;

let googleConfigured = false;
function ensureGoogleConfigured(): boolean {
  if (!GOOGLE_WEB_CLIENT_ID || !GOOGLE_IOS_CLIENT_ID) return false;
  if (!googleConfigured) {
    GoogleSignin.configure({
      // webClientId is the audience Supabase validates the Google idToken against.
      webClientId: GOOGLE_WEB_CLIENT_ID,
      iosClientId: GOOGLE_IOS_CLIENT_ID,
    });
    googleConfigured = true;
  }
  return true;
}

// A fresh, high-entropy nonce per Apple sign-in. The SHA-256 hash is sent to
// Apple; the raw value is handed to Supabase, which re-hashes and compares.
function generateRawNonce(): string {
  const bytes = Crypto.getRandomBytes(32);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Collapse raw provider/Supabase errors into concise, non-sensitive copy.
// Never surface tokens, identifiers, or full provider payloads to the UI.
function mapProviderError(provider: 'apple' | 'google', message?: string): string {
  const normalized = (message ?? '').toLowerCase();
  if (
    normalized.includes('already registered') ||
    normalized.includes('already been registered') ||
    normalized.includes('already exists') ||
    normalized.includes('identity is already linked') ||
    normalized.includes('email address is already') ||
    normalized.includes('email already')
  ) {
    return 'This email is already linked to a Youmi Lens account created with a different sign-in method. Please sign in with that method (for example, your email and password).';
  }
  return provider === 'apple'
    ? 'Apple sign-in could not be completed. Please try again.'
    : 'Google sign-in could not be completed. Please try again.';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // True when the user chose "Continue without account". A real session always
  // supersedes guest mode, so signing in clears this flag.
  const [isGuest, setIsGuest] = useState(false);
  // True between PASSWORD_RECOVERY and the next SIGNED_OUT. Lets the AuthGate
  // keep the user on /auth long enough to enter a new password.
  const [isResettingPassword, setIsResettingPassword] = useState(false);
  const [needsUsernameSetup, setNeedsUsernameSetup] = useState(false);

  const loadUsername = useCallback(async (nextUser: User | null) => {
    if (!nextUser) {
      setUsername(null);
      setNeedsUsernameSetup(false);
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
      setNeedsUsernameSetup(!metadataUsername);
      return;
    }

    const nextUsername = data?.username ?? metadataUsername;
    setUsername(nextUsername);
    setNeedsUsernameSetup(!nextUsername);
  }, []);

  const applySessionState = useCallback(
    async (nextSession: Session | null) => {
      setUser(nextSession?.user ?? null);
      await loadUsername(nextSession?.user ?? null);
      setSession(nextSession);
    },
    [loadUsername],
  );

  useEffect(() => {
    let mounted = true;

    supabase.auth
      .getSession()
      .then(async ({ data, error }) => {
        if (!mounted) return;
        const nextSession = error ? null : data.session;
        await applySessionState(nextSession);
        if (nextSession) {
          // A real session supersedes any persisted guest choice.
          setIsGuest(false);
          await AsyncStorage.removeItem(GUEST_MODE_KEY).catch(() => {});
        } else {
          const flag = await AsyncStorage.getItem(GUEST_MODE_KEY).catch(() => null);
          if (mounted && flag === '1') setIsGuest(true);
        }
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
      // Signing in always leaves guest mode behind.
      if (nextSession) {
        setIsGuest(false);
        void AsyncStorage.removeItem(GUEST_MODE_KEY).catch(() => {});
      }
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

  // Create Profile, step 1: Supabase signUp. With email confirmation enabled,
  // Supabase emails a verification code (Confirm sign up template → {{ .Token }})
  // and returns no session — the code is verified in step 2.
  const createProfileWithPassword = useCallback(
    async (email: string, password: string): Promise<VerifySignupResult> => {
      if (supabaseConfigError) return { error: supabaseConfigError, session: null };

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
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
        await applySessionState(data.session);
      }
      return { error: null, session: data.session };
    },
    [applySessionState],
  );

  // Create Profile, step 2: verify the Supabase signup confirmation code.
  const verifySignupCode = useCallback(
    async (email: string, code: string): Promise<VerifySignupResult> => {
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

      await applySessionState(data.session);
      return { error: null, session: data.session };
    },
    [applySessionState],
  );

  // ── Sign in with Apple (native) ─────────────────────────────────────────────
  // Uses the system Sign in with Apple sheet, then exchanges the verified Apple
  // identity token with Supabase via signInWithIdToken. The same Supabase user.id
  // continues to own courses, recordings, quota, entitlements, and IAP.
  const signInWithApple = useCallback(async (): Promise<AuthResult> => {
    const rawNonce = generateRawNonce();
    const hashedNonce = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      rawNonce,
    );

    let credential: AppleAuthentication.AppleAuthenticationCredential;
    try {
      credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
        nonce: hashedNonce,
      });
    } catch (e) {
      // User dismissed the Apple sheet — stay on the auth screen, no error.
      if ((e as { code?: string })?.code === 'ERR_REQUEST_CANCELED') return { error: null };
      return { error: mapProviderError('apple') };
    }

    const identityToken = credential.identityToken;
    if (!identityToken) {
      return { error: 'Apple did not return an identity token. Please try again.' };
    }

    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: identityToken,
      nonce: rawNonce,
    });
    if (error) return { error: mapProviderError('apple', error.message) };
    if (!data.session) return { error: 'Sign-in completed without a valid session.' };

    // Apple returns the full name only on the *first* authorization. Persist it
    // to auth metadata (best-effort) so the existing username/profile flow can
    // offer it; never block sign-in on this, and never overwrite a chosen name.
    const display = [credential.fullName?.givenName, credential.fullName?.familyName]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (display) {
      await supabase.auth.updateUser({ data: { full_name: display } }).catch(() => {});
    }

    await applySessionState(data.session);
    return { error: null };
  }, [applySessionState]);

  // ── Sign in with Google (native) ────────────────────────────────────────────
  const signInWithGoogle = useCallback(async (): Promise<AuthResult> => {
    if (!ensureGoogleConfigured()) {
      return { error: 'Google sign-in is not configured yet. Please try another method.' };
    }
    try {
      if (Platform.OS === 'android') await GoogleSignin.hasPlayServices();
      const response = await GoogleSignin.signIn();
      // New-API cancellation: a non-success response means the user backed out.
      if (!isSuccessResponse(response)) return { error: null };

      const idToken = response.data.idToken;
      if (!idToken) {
        return { error: 'Google did not return an ID token. Please try again.' };
      }

      const { data, error } = await supabase.auth.signInWithIdToken({
        provider: 'google',
        token: idToken,
      });
      if (error) return { error: mapProviderError('google', error.message) };
      if (!data.session) return { error: 'Sign-in completed without a valid session.' };
      await applySessionState(data.session);
      return { error: null };
    } catch (e) {
      if (isErrorWithCode(e) && e.code === statusCodes.SIGN_IN_CANCELLED) return { error: null };
      if (isErrorWithCode(e) && e.code === statusCodes.IN_PROGRESS) {
        return { error: 'A sign-in is already in progress.' };
      }
      return { error: mapProviderError('google') };
    }
  }, [applySessionState]);

  const signInWithProvider = useCallback(
    async (provider: 'apple' | 'google'): Promise<AuthResult> => {
      if (supabaseConfigError) return { error: supabaseConfigError };
      return provider === 'apple' ? signInWithApple() : signInWithGoogle();
    },
    [signInWithApple, signInWithGoogle],
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

      const upsertWithTimestamp = await supabase
        .from('profiles')
        .upsert({ id: user.id, username: trimmed, updated_at: new Date().toISOString() });

      let error = upsertWithTimestamp.error;
      if (error && /updated_at/i.test(error.message)) {
        const upsertWithoutTimestamp = await supabase
          .from('profiles')
          .upsert({ id: user.id, username: trimmed });
        error = upsertWithoutTimestamp.error;
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
      setNeedsUsernameSetup(false);
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

  const continueAsGuest = useCallback(async (): Promise<void> => {
    await AsyncStorage.setItem(GUEST_MODE_KEY, '1').catch(() => {});
    setIsGuest(true);
  }, []);

  const exitGuest = useCallback(async (): Promise<void> => {
    await AsyncStorage.removeItem(GUEST_MODE_KEY).catch(() => {});
    setIsGuest(false);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      session,
      loading,
      username,
      isGuest,
      continueAsGuest,
      exitGuest,
      isResettingPassword,
      needsUsernameSetup,
      createProfileWithPassword,
      verifySignupCode,
      signInWithProvider,
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
      isGuest,
      continueAsGuest,
      exitGuest,
      isResettingPassword,
      needsUsernameSetup,
      createProfileWithPassword,
      verifySignupCode,
      signInWithProvider,
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
