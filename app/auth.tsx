import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppBackground } from '@/components/AppBackground';
import { GlassCard } from '@/components/GlassCard';
import { PrimaryButton } from '@/components/PrimaryButton';
import { SecondaryButton } from '@/components/SecondaryButton';
import { colors, fontSize, radius, spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth';
import { checkEmailExists } from '@/lib/checkEmail';

type EntryMode = 'createProfile' | 'signIn';
type AuthStep =
  | 'entry'
  | 'signupCode'
  | 'signInCodeEmail'
  | 'signInCodeVerify'
  | 'resetEmail'
  | 'resetVerify'
  | 'resetNewPassword';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EXISTING_ACCOUNT_MESSAGE =
  'This email already has a Youmi Lens account. Please sign in or use an email verification code.';

export default function AuthScreen() {
  const router = useRouter();
  const { width, height } = useWindowDimensions();
  const {
    session,
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
    signOut,
    isResettingPassword,
    needsUsernameSetup,
    signInWithProvider,
    continueAsGuest,
  } = useAuth();
  const [entryMode, setEntryMode] = useState<EntryMode>('signIn');
  const [step, setStep] = useState<AuthStep>('entry');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pendingEmail, setPendingEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [persistentError, setPersistentError] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetConfirmPassword, setResetConfirmPassword] = useState('');
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [signInPasswordVisible, setSignInPasswordVisible] = useState(false);
  const [createPasswordVisible, setCreatePasswordVisible] = useState(false);
  const [resetPasswordVisible, setResetPasswordVisible] = useState(false);
  const [resetConfirmPasswordVisible, setResetConfirmPasswordVisible] = useState(false);
  const [busyAction, setBusyAction] = useState<'send' | 'verify' | 'signin' | 'resend' | 'updatePassword' | 'provider' | 'username' | null>(null);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const entryTransition = useRef(new Animated.Value(1)).current;
  const showBrandPanel = width >= 900 && width > height;

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    entryTransition.stopAnimation();
    if (reduceMotion) {
      entryTransition.setValue(1);
      return;
    }
    entryTransition.setValue(0);
    Animated.timing(entryTransition, {
      toValue: 1,
      duration: 250,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: true,
    }).start();
  }, [entryMode, entryTransition, reduceMotion]);

  useEffect(() => {
    if (session && !isResettingPassword && !needsUsernameSetup && step !== 'resetNewPassword') {
      router.replace('/');
    }
  }, [isResettingPassword, needsUsernameSetup, router, session, step]);

  const validateEmail = (value: string) => {
    if (!value.trim()) return 'Please enter your email.';
    if (!EMAIL_PATTERN.test(value.trim())) return 'Please enter a valid email address.';
    return null;
  };

  const switchMode = (nextMode: EntryMode) => {
    setEntryMode(nextMode);
    setStep('entry');
    setError(null);
    setPersistentError(null);
    setCode('');
    setResetPassword('');
    setResetConfirmPassword('');
    setSuccessMessage(null);
  };

  // ── Create Profile: step 1 — Supabase signUp, which emails the code ─────────
  const handleCreateProfile = async () => {
    const trimmedEmail = email.trim();

    const emailError = validateEmail(trimmedEmail);
    if (emailError) return setError(emailError);
    if (!password) return setError('Please enter a password.');
    if (password.length < 8) return setError('Password must be at least 8 characters.');

    setBusyAction('send');
    setError(null);
    setPersistentError(null);

    // One email = one account. Check BEFORE signUp: with email enumeration
    // protection on, Supabase signUp returns a fake success for an existing
    // email, so this pre-check is what blocks duplicates before Verify Email.
    const emailCheck = await checkEmailExists(trimmedEmail);
    if (!emailCheck.ok) {
      setBusyAction(null);
      setError(emailCheck.message);
      return;
    }
    if (emailCheck.exists) {
      setBusyAction(null);
      setEntryMode('signIn');
      setStep('entry');
      setPersistentError(EXISTING_ACCOUNT_MESSAGE);
      return;
    }

    const { error: createError, session: nextSession } = await createProfileWithPassword(trimmedEmail, password);
    setBusyAction(null);

    if (createError) {
      if (createError.includes('already has a Youmi Lens account')) {
        setEntryMode('signIn');
        setStep('entry');
        setPersistentError(createError);
        return;
      }
      setError(createError);
      return;
    }

    // Email confirmation disabled → signed in immediately.
    if (nextSession) {
      return;
    }

    // Email confirmation enabled → verify the emailed code next.
    setPendingEmail(trimmedEmail);
    setCode('');
    setStep('signupCode');
  };

  // ── Create Profile: step 2 — verify the Supabase signup code ────────────────
  const handleVerifyAndCreate = async () => {
    const trimmedCode = code.replace(/\s/g, '');
    if (!trimmedCode) return setError('Please enter the verification code.');
    if (!/^\d{6,8}$/.test(trimmedCode)) return setError('Enter the verification code from your email.');

    setBusyAction('verify');
    setError(null);
    const { error: verifyError } = await verifySignupCode(email.trim(), trimmedCode);
    setBusyAction(null);

    if (verifyError) {
      setError(verifyError);
      return;
    }
  };

  const handleProviderSignIn = async (provider: 'apple' | 'google') => {
    if (busyAction) return;
    setBusyAction('provider');
    setError(null);
    // try/catch/finally guarantees the loading state always clears — even if a
    // provider/native call throws unexpectedly — so the login card never gets
    // stuck on a spinner or left blank with disabled buttons.
    try {
      const result = await signInWithProvider(provider);
      if (result.error) setError(result.error);
    } catch {
      setError('Sign-in is temporarily unavailable. Please try again later.');
    } finally {
      setBusyAction(null);
    }
  };

  const handleUsernameSetup = async () => {
    const trimmed = username.trim();
    if (trimmed.length < 2 || trimmed.length > 64) {
      setError('Username must be 2–64 characters.');
      return;
    }
    setBusyAction('username');
    setError(null);
    const result = await updateUsername(trimmed);
    setBusyAction(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    router.replace('/');
  };

  const handleResendSignupCode = async () => {
    setBusyAction('resend');
    setError(null);
    const { error: resendError } = await resendSignupCode(email.trim());
    setBusyAction(null);
    if (resendError) setError(resendError);
  };

  const backToCreateProfile = () => {
    setStep('entry');
    setError(null);
    setCode('');
    setResetPassword('');
    setResetConfirmPassword('');
    setSuccessMessage(null);
  };

  const handleSendSignInCode = async () => {
    const trimmedEmail = email.trim();
    const emailError = validateEmail(trimmedEmail);
    if (emailError) return setError(emailError);

    setBusyAction('send');
    setError(null);
    setPersistentError(null);
    const { error: sendError } = await sendSignInCode(trimmedEmail);
    setBusyAction(null);
    if (sendError) {
      setError(sendError);
      return;
    }

    setPendingEmail(trimmedEmail);
    setCode('');
    setStep('signInCodeVerify');
  };

  const handleVerifySignInCode = async () => {
    const trimmedCode = code.replace(/\s/g, '');
    if (!trimmedCode) return setError('Please enter the verification code.');
    if (!/^\d{6,8}$/.test(trimmedCode)) return setError('Enter the verification code from your email.');

    setBusyAction('verify');
    setError(null);
    const { error: verifyError, session: nextSession } = await verifySignInCode(pendingEmail, trimmedCode);
    setBusyAction(null);
    if (verifyError) {
      setError(verifyError);
      return;
    }

    if (nextSession) router.replace('/');
  };

  const handleResendSignInCode = async () => {
    setBusyAction('resend');
    setError(null);
    const { error: resendError } = await sendSignInCode(pendingEmail);
    setBusyAction(null);
    if (resendError) setError(resendError);
  };

  const handleSignIn = async () => {
    const trimmedEmail = email.trim();
    const emailError = validateEmail(trimmedEmail);
    if (emailError) return setError(emailError);
    if (!password) return setError('Please enter your password.');

    setBusyAction('signin');
    setError(null);
    const { error: signInError } = await signInWithPassword(trimmedEmail, password);
    setBusyAction(null);
    if (signInError) {
      setError(signInError);
      return;
    }
    setPersistentError(null);
    router.replace('/');
  };

  const changeEmail = () => {
    setStep('entry');
    setError(null);
    setCode('');
    setResetPassword('');
    setResetConfirmPassword('');
    setSuccessMessage(null);
  };

  const openPasswordReset = () => {
    setStep('resetEmail');
    setEntryMode('signIn');
    setError(null);
    setPersistentError(null);
    setSuccessMessage(null);
    setCode('');
    setResetPassword('');
    setResetConfirmPassword('');
  };

  const backToPasswordSignIn = () => {
    setStep('entry');
    setEntryMode('signIn');
    setError(null);
    setPersistentError(null);
    setSuccessMessage(null);
    setCode('');
    setResetPassword('');
    setResetConfirmPassword('');
  };

  const handleSendPasswordResetCode = async () => {
    const trimmedEmail = email.trim();
    const emailError = validateEmail(trimmedEmail);
    if (emailError) return setError(emailError);

    setBusyAction('send');
    setError(null);
    setSuccessMessage(null);
    const { error: sendError } = await sendPasswordResetCode(trimmedEmail);
    setBusyAction(null);

    if (sendError && !sendError.toLowerCase().includes('user not found')) {
      setError(sendError);
      return;
    }

    setPendingEmail(trimmedEmail);
    setCode('');
    setSuccessMessage('If an account exists for this email, we sent a verification code.');
    setStep('resetVerify');
  };

  const handleVerifyPasswordResetCode = async () => {
    const trimmedCode = code.replace(/\s/g, '');
    if (!trimmedCode) return setError('Please enter the verification code.');
    if (!/^\d{6,8}$/.test(trimmedCode)) return setError('Enter the verification code from your email.');

    setBusyAction('verify');
    setError(null);
    const { error: verifyError, session: recoverySession } = await verifyPasswordResetCode(pendingEmail, trimmedCode);
    setBusyAction(null);
    if (verifyError) {
      setError(verifyError);
      return;
    }
    if (recoverySession) {
      setResetPassword('');
      setResetConfirmPassword('');
      setSuccessMessage(null);
      setStep('resetNewPassword');
    }
  };

  const handleResendPasswordResetCode = async () => {
    setBusyAction('resend');
    setError(null);
    const { error: resendError } = await sendPasswordResetCode(pendingEmail);
    setBusyAction(null);
    if (resendError && !resendError.toLowerCase().includes('user not found')) {
      setError(resendError);
      return;
    }
    setSuccessMessage('If an account exists for this email, we sent a verification code.');
  };

  const handleContinueAsGuest = async () => {
    await continueAsGuest();
    router.replace('/');
  };

  const handleUpdatePassword = async () => {
    if (!resetPassword) return setError('Please enter a new password.');
    if (resetPassword.length < 8) return setError('Password must be at least 8 characters.');
    if (!resetConfirmPassword) return setError('Please confirm your new password.');
    if (resetPassword !== resetConfirmPassword) return setError('Passwords do not match.');

    setBusyAction('updatePassword');
    setError(null);
    const { error: updateError } = await updatePassword(resetPassword);
    if (updateError) {
      setBusyAction(null);
      setError(updateError);
      return;
    }

    await signOut();
    setBusyAction(null);
    setPassword('');
    setResetPassword('');
    setResetConfirmPassword('');
    setCode('');
    setStep('entry');
    setEntryMode('signIn');
    setSuccessMessage('Password updated. Please sign in with your new password.');
  };

  return (
    <View style={styles.root}>
      <AppBackground />
      {showBrandPanel ? <BrandPanel /> : null}
      <SafeAreaView style={styles.authArea} edges={['top', 'bottom', 'left', 'right']}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.keyboardAvoider}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
        <View style={styles.content}>
          <GlassCard padding={28} style={styles.loginCard}>
          <View style={styles.card}>
            {session && needsUsernameSetup ? (
              <View style={styles.codeWrap}>
                <View style={styles.headerCopy}>
                  <Text style={styles.cardTitle}>Choose your username</Text>
                  <Text style={styles.cardSubtitle}>This is how your name will appear in your Youmi Lens workspace.</Text>
                </View>
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>Username</Text>
                  <TextInput
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder="yourname"
                    placeholderTextColor="#A8B3C2"
                    onBlur={() => setFocusedField(null)}
                    onFocus={() => setFocusedField('username')}
                    style={[styles.input, focusedField === 'username' && styles.inputFocused]}
                    value={username}
                    onChangeText={(value) => {
                      setUsername(value);
                      setError(null);
                    }}
                  />
                </View>
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <PrimaryButton
                  label="Continue"
                  onPress={handleUsernameSetup}
                  loading={busyAction === 'username'}
                  disabled={busyAction !== null}
                  style={styles.primaryAction}
                />
              </View>
            ) : step === 'signupCode' ? (
              <View style={styles.codeWrap}>
                <View style={styles.headerCopy}>
                  <Text style={styles.cardTitle}>Verify your email</Text>
                  <Text style={styles.cardSubtitle}>Enter the verification code we sent to your email.</Text>
                </View>
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>Verification code</Text>
                  <TextInput
                    keyboardType="number-pad"
                    maxLength={8}
                    placeholder="Verification code"
                    placeholderTextColor={colors.textTertiary}
                    style={[styles.input, styles.codeInput]}
                    value={code}
                    onChangeText={(value) => { setCode(value.replace(/\s/g, '')); setError(null); }}
                  />
                </View>
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <PrimaryButton label="Verify and create account" onPress={handleVerifyAndCreate} loading={busyAction === 'verify'} disabled={busyAction !== null} />
                <SecondaryButton label="Resend code" tone="ice" onPress={handleResendSignupCode} disabled={busyAction !== null} />
                <Pressable accessibilityRole="button" onPress={backToCreateProfile} style={styles.textButton}>
                  <Text style={styles.textButtonLabel}>Back to create profile</Text>
                </Pressable>
              </View>
            ) : step === 'resetEmail' ? (
              <View style={styles.codeWrap}>
                <View style={styles.headerCopy}>
                  <Text style={styles.cardTitle}>Reset your password</Text>
                  <Text style={styles.cardSubtitle}>Enter your email and we’ll send you a verification code.</Text>
                </View>
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>Email</Text>
                  <TextInput autoCapitalize="none" autoComplete="email" keyboardType="email-address" placeholder="student@example.com" placeholderTextColor={colors.textTertiary} style={styles.input} value={email} onChangeText={(value) => { setEmail(value); setError(null); setSuccessMessage(null); }} />
                </View>
                {successMessage ? <Text style={styles.success}>{successMessage}</Text> : null}
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <PrimaryButton label="Send verification code" onPress={handleSendPasswordResetCode} loading={busyAction === 'send'} disabled={busyAction !== null} />
                <Pressable accessibilityRole="button" onPress={backToPasswordSignIn} style={styles.textButton}>
                  <Text style={styles.textButtonLabel}>Back to password sign in</Text>
                </Pressable>
              </View>
            ) : step === 'resetVerify' ? (
              <View style={styles.codeWrap}>
                <View style={styles.headerCopy}>
                  <Text style={styles.cardTitle}>Check your email</Text>
                  <Text style={styles.cardSubtitle}>Enter the verification code we sent to your email.</Text>
                </View>
                {successMessage ? <Text style={styles.success}>{successMessage}</Text> : null}
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>Verification code</Text>
                  <TextInput
                    keyboardType="number-pad"
                    maxLength={8}
                    placeholder="Verification code"
                    placeholderTextColor={colors.textTertiary}
                    style={[styles.input, styles.codeInput]}
                    value={code}
                    onChangeText={(value) => { setCode(value.replace(/\s/g, '')); setError(null); }}
                  />
                </View>
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <PrimaryButton label="Verify code" onPress={handleVerifyPasswordResetCode} loading={busyAction === 'verify'} disabled={busyAction !== null} />
                <SecondaryButton label="Resend code" tone="ice" onPress={handleResendPasswordResetCode} disabled={busyAction !== null} />
                <Pressable accessibilityRole="button" onPress={backToPasswordSignIn} style={styles.textButton}>
                  <Text style={styles.textButtonLabel}>Back to password sign in</Text>
                </Pressable>
              </View>
            ) : step === 'resetNewPassword' ? (
              <View style={styles.codeWrap}>
                <View style={styles.headerCopy}>
                  <Text style={styles.cardTitle}>Create a new password</Text>
                  <Text style={styles.cardSubtitle}>Choose a new password for your Youmi Lens account.</Text>
                </View>
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>New Password</Text>
                  <PasswordInput
                    value={resetPassword}
                    onChangeText={(value) => { setResetPassword(value); setError(null); }}
                    placeholder="New password"
                    visible={resetPasswordVisible}
                    onToggleVisible={() => setResetPasswordVisible((current) => !current)}
                    textContentType="newPassword"
                  />
                </View>
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>Confirm New Password</Text>
                  <PasswordInput
                    value={resetConfirmPassword}
                    onChangeText={(value) => {
                      if (__DEV__) console.log('[auth] confirm password changed');
                      setResetConfirmPassword(value);
                      setError(null);
                    }}
                    onFocus={() => {
                      if (__DEV__) console.log('[auth] confirm password focused');
                    }}
                    placeholder="Confirm new password"
                    visible={resetConfirmPasswordVisible}
                    onToggleVisible={() => setResetConfirmPasswordVisible((current) => !current)}
                    editable={busyAction !== 'updatePassword'}
                    confirm
                  />
                </View>
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <PrimaryButton label="Update password" onPress={handleUpdatePassword} loading={busyAction === 'updatePassword'} disabled={busyAction !== null} />
              </View>
            ) : step === 'signInCodeEmail' ? (
              <View style={styles.codeWrap}>
                <View style={styles.headerCopy}>
                  <Text style={styles.cardTitle}>Sign in with verification code</Text>
                  <Text style={styles.cardSubtitle}>Enter your email and we’ll send you a verification code.</Text>
                </View>
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>Email</Text>
                  <TextInput autoCapitalize="none" autoComplete="email" keyboardType="email-address" placeholder="student@example.com" placeholderTextColor={colors.textTertiary} style={styles.input} value={email} onChangeText={(value) => { setEmail(value); setError(null); }} />
                </View>
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <PrimaryButton label="Send verification code" onPress={handleSendSignInCode} loading={busyAction === 'send'} disabled={busyAction !== null} />
                <Pressable accessibilityRole="button" onPress={changeEmail} style={styles.textButton}>
                  <Text style={styles.textButtonLabel}>Back to password sign in</Text>
                </Pressable>
              </View>
            ) : step === 'signInCodeVerify' ? (
              <View style={styles.codeWrap}>
                <View style={styles.headerCopy}>
                  <Text style={styles.cardTitle}>Check your email</Text>
                  <Text style={styles.cardSubtitle}>Enter the verification code we sent to your email.</Text>
                </View>
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>Verification code</Text>
                  <TextInput
                    keyboardType="number-pad"
                    maxLength={8}
                    placeholder="Verification code"
                    placeholderTextColor={colors.textTertiary}
                    style={[styles.input, styles.codeInput]}
                    value={code}
                    onChangeText={(value) => { setCode(value.replace(/\s/g, '')); setError(null); }}
                  />
                </View>
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <PrimaryButton label="Verify and sign in" onPress={handleVerifySignInCode} loading={busyAction === 'verify'} disabled={busyAction !== null} />
                <SecondaryButton label="Resend code" tone="ice" onPress={handleResendSignInCode} disabled={busyAction !== null} />
                <Pressable accessibilityRole="button" onPress={changeEmail} style={styles.textButton}>
                  <Text style={styles.textButtonLabel}>Back to password sign in</Text>
                </Pressable>
              </View>
            ) : (
              <Animated.View
                style={[
                  styles.entryView,
                  {
                    opacity: entryTransition,
                    transform: [{ translateY: entryTransition.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }],
                  },
                ]}
              >
                <View style={styles.headerCopy}>
                  <Text style={styles.cardTitle}>{entryMode === 'createProfile' ? 'Create your account' : 'Welcome back'}</Text>
                  <View style={styles.authSwitchRow}>
                    <Text style={styles.cardSubtitle}>
                      {entryMode === 'createProfile' ? 'Already have one? ' : 'New to Youmi Lens? '}
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => switchMode(entryMode === 'createProfile' ? 'signIn' : 'createProfile')}
                    >
                      <Text style={styles.authSwitchLink}>
                        {entryMode === 'createProfile' ? 'Sign in' : 'Create an account'}
                      </Text>
                    </Pressable>
                  </View>
                </View>

                <View style={styles.ssoStack}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busyAction !== null}
                    onPress={() => void handleProviderSignIn('apple')}
                    style={({ pressed }) => [styles.ssoButton, styles.appleButton, pressed && styles.ssoPressed]}
                  >
                    <Ionicons name="logo-apple" size={20} color="#FFFFFF" />
                    <Text style={styles.appleButtonText}>Continue with Apple</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busyAction !== null}
                    onPress={() => void handleProviderSignIn('google')}
                    style={({ pressed }) => [styles.ssoButton, styles.googleButton, pressed && styles.ssoPressed]}
                  >
                    <GoogleMark />
                    <Text style={styles.googleButtonText}>Continue with Google</Text>
                  </Pressable>
                </View>

                <View style={styles.emailDivider}>
                  <View style={styles.dividerLine} />
                  <Text style={styles.dividerText}>
                    {entryMode === 'createProfile' ? 'or sign up with email' : 'or sign in with email'}
                  </Text>
                  <View style={styles.dividerLine} />
                </View>

                {entryMode === 'createProfile' ? (
                  <>
                    <View style={styles.fieldGroup}>
                      <Text style={styles.label}>Email</Text>
                      <TextInput
                        autoCapitalize="none"
                        autoComplete="email"
                        keyboardType="email-address"
                        placeholder="student@example.com"
                        placeholderTextColor="#A8B3C2"
                        onBlur={() => setFocusedField(null)}
                        onFocus={() => setFocusedField('create-email')}
                        style={[styles.input, focusedField === 'create-email' && styles.inputFocused]}
                        value={email}
                        onChangeText={(value) => { setEmail(value); setError(null); setPersistentError(null); }}
                      />
                    </View>
                    <View style={styles.fieldGroup}>
                      <Text style={styles.label}>Password</Text>
                      <PasswordInput value={password} onChangeText={(value) => { setPassword(value); setError(null); }} placeholder="At least 8 characters" visible={createPasswordVisible} onToggleVisible={() => setCreatePasswordVisible((current) => !current)} textContentType="newPassword" />
                      <Text style={styles.hint}>We’ll email you a 6-digit code to verify it’s you. You can pick a username after.</Text>
                    </View>
                  </>
                ) : (
                  <>
                    <View style={styles.fieldGroup}>
                      <Text style={styles.label}>Email</Text>
                      <TextInput
                        autoCapitalize="none"
                        autoComplete="email"
                        keyboardType="email-address"
                        placeholder="student@example.com"
                        placeholderTextColor="#A8B3C2"
                        onBlur={() => setFocusedField(null)}
                        onFocus={() => setFocusedField('signin-email')}
                        style={[styles.input, focusedField === 'signin-email' && styles.inputFocused]}
                        value={email}
                        onChangeText={(value) => { setEmail(value); setPersistentError(null); setError(null); }}
                      />
                    </View>
                    <View style={styles.fieldGroup}>
                      <Text style={styles.label}>Password</Text>
                      <PasswordInput value={password} onChangeText={(value) => { setPassword(value); setError(null); }} placeholder="Your password" visible={signInPasswordVisible} onToggleVisible={() => setSignInPasswordVisible((current) => !current)} textContentType="password" />
                    </View>
                  </>
                )}

                {error ? <Text style={styles.error}>{error}</Text> : null}

                {entryMode === 'createProfile' ? (
                  <>
                    <PrimaryButton label="Create account" onPress={handleCreateProfile} loading={busyAction === 'send'} disabled={busyAction !== null} style={styles.primaryAction} />
                  </>
                ) : (
                  <>
                    <Pressable accessibilityRole="button" onPress={openPasswordReset} style={styles.forgotButton}>
                      <Text style={styles.textButtonLabel}>Forgot password?</Text>
                    </Pressable>
                    <PrimaryButton label="Sign in" onPress={handleSignIn} loading={busyAction === 'signin'} disabled={busyAction !== null} style={styles.primaryAction} />
                  </>
                )}
                {successMessage ? <Text style={styles.success}>{successMessage}</Text> : null}
                {persistentError ? <ErrorNotice message={persistentError} /> : null}

                <View style={styles.guestFooter}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={handleContinueAsGuest}
                    disabled={busyAction !== null}
                    style={({ pressed }) => pressed && styles.pressed}
                  >
                    <Text style={styles.guestButtonLabel}>Continue without an account</Text>
                  </Pressable>
                  <Text style={styles.guestHelper}>Guest recordings stay on this device only.</Text>
                </View>
              </Animated.View>
            )}
          </View>
          </GlassCard>
        </View>
        </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const CAPTION_PAIRS = [
  {
    en: "Today we'll look at how neural networks learn from data.",
    zh: '今天我们来看看神经网络是如何从数据中学习的。',
  },
  {
    en: 'Each layer extracts increasingly abstract features.',
    zh: '每一层都会提取越来越抽象的特征。',
  },
  {
    en: "Let's start with a simple example",
    zh: '我们从一个简单的例子开始',
  },
] as const;

function BrandPanel() {
  const [reduceMotion, setReduceMotion] = useState(false);
  const [panelSize, setPanelSize] = useState({ width: 0, height: 0 });
  const captionAnimations = useRef(CAPTION_PAIRS.map(() => new Animated.Value(0))).current;
  const pulse = useRef(new Animated.Value(1)).current;
  const cursor = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    captionAnimations.forEach((value) => value.stopAnimation());
    pulse.stopAnimation();
    cursor.stopAnimation();

    if (reduceMotion) {
      captionAnimations.forEach((value) => value.setValue(1));
      pulse.setValue(1);
      cursor.setValue(1);
      return;
    }

    captionAnimations.forEach((value) => value.setValue(0));
    const captionDelays = [0, 500, 2400];
    captionAnimations.forEach((value, index) => {
      Animated.timing(value, {
        toValue: 1,
        duration: 900,
        delay: captionDelays[index],
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    });

    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.8, duration: 1100, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    ).start();
    Animated.loop(
      Animated.sequence([
        Animated.timing(cursor, { toValue: 0, duration: 500, easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(cursor, { toValue: 1, duration: 500, easing: Easing.linear, useNativeDriver: true }),
      ]),
    ).start();
  }, [captionAnimations, cursor, pulse, reduceMotion]);

  return (
    <View
      style={styles.brandPanel}
      onLayout={({ nativeEvent }) => {
        const { width, height } = nativeEvent.layout;
        setPanelSize((current) =>
          current.width === width && current.height === height ? current : { width, height },
        );
      }}
    >
      {panelSize.width > 0 && panelSize.height > 0 ? (
        <Svg
          pointerEvents="none"
          width={panelSize.width}
          height={panelSize.height}
          viewBox={`0 0 ${panelSize.width} ${panelSize.height}`}
          style={StyleSheet.absoluteFill}
        >
          <Defs>
            <LinearGradient
              id="auth-bg"
              gradientUnits="userSpaceOnUse"
              x1={0}
              y1={0}
              x2={0}
              y2={panelSize.height}
            >
              <Stop offset="0" stopColor="#1A2B47" />
              <Stop offset="1" stopColor="#101B2D" />
            </LinearGradient>
            <LinearGradient
              id="auth-glow"
              gradientUnits="userSpaceOnUse"
              x1={0}
              y1={0}
              x2={panelSize.width}
              y2={panelSize.height}
            >
              <Stop offset="0" stopColor="#4A7DBF" stopOpacity={0.22} />
              <Stop offset="0.58" stopColor="#4A7DBF" stopOpacity={0.06} />
              <Stop offset="1" stopColor="#4A7DBF" stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect width={panelSize.width} height={panelSize.height} fill="url(#auth-bg)" />
          <Rect width={panelSize.width} height={panelSize.height} fill="url(#auth-glow)" />
        </Svg>
      ) : null}

      <View style={styles.brandContent}>
        <View style={styles.brandTop}>
          <Image
            accessibilityIgnoresInvertColors
            accessibilityLabel="Youmi Lens"
            resizeMode="contain"
            source={require('../assets/images/youmi-mark-white.png')}
            style={styles.brandMark}
          />
          <Text style={styles.brandName}>Youmi Lens</Text>
        </View>

        <View style={styles.captionStage}>
          <View style={styles.liveLabel}>
            <Animated.View
              style={[
                styles.recDot,
                {
                  opacity: pulse.interpolate({ inputRange: [0.8, 1], outputRange: [0.45, 1] }),
                  transform: [{ scale: pulse }],
                },
              ]}
            />
            <Text style={styles.liveLabelText}>Live captions · 实时字幕</Text>
          </View>
          {CAPTION_PAIRS.map((pair, index) => {
            const animation = captionAnimations[index];
            return (
              <Animated.View
                key={pair.en}
                style={[
                  styles.captionPair,
                  {
                    opacity: animation,
                    transform: [{ translateY: animation.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
                  },
                ]}
              >
                <View style={styles.captionEnglishRow}>
                  <Text style={styles.captionEnglish}>{pair.en}</Text>
                  {index === CAPTION_PAIRS.length - 1 ? <Animated.View style={[styles.captionCursor, { opacity: cursor }]} /> : null}
                </View>
                <Text style={styles.captionChinese}>{pair.zh}</Text>
              </Animated.View>
            );
          })}
        </View>

        <View>
          <Text style={styles.brandTagline}>A calm lecture workspace.</Text>
          <Text style={styles.brandDescription}>
            Real-time bilingual captions, transcripts, and AI summaries — on iPad and Mac.
          </Text>
        </View>
      </View>
    </View>
  );
}

function GoogleMark() {
  return (
    <Svg width={18} height={18} viewBox="0 0 18 18">
      <Rect width={18} height={18} fill="transparent" />
      <Path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <Path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <Path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.69 9c0-.6.1-1.18.28-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z" />
      <Path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </Svg>
  );
}

type PasswordInputProps = {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  visible: boolean;
  onToggleVisible: () => void;
  confirm?: boolean;
  editable?: boolean;
  textContentType?: 'password' | 'newPassword';
  onFocus?: () => void;
};

function PasswordInput({
  value,
  onChangeText,
  placeholder,
  visible,
  onToggleVisible,
  confirm = false,
  editable = true,
  textContentType,
  onFocus,
}: PasswordInputProps) {
  const [focused, setFocused] = useState(false);
  const accessibilityLabel = visible
    ? confirm ? 'Hide confirm password' : 'Hide password'
    : confirm ? 'Show confirm password' : 'Show password';

  return (
    <View style={styles.passwordWrap}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onBlur={() => setFocused(false)}
        onFocus={() => {
          setFocused(true);
          onFocus?.();
        }}
        placeholder={placeholder}
        placeholderTextColor="#A8B3C2"
        secureTextEntry={!visible}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete={textContentType === 'password' ? 'current-password' : textContentType === 'newPassword' ? 'new-password' : 'off'}
        textContentType={textContentType ?? 'none'}
        editable={editable}
        style={[styles.input, styles.passwordInput, focused && styles.inputFocused]}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        hitSlop={10}
        onPress={onToggleVisible}
        style={({ pressed }) => [styles.passwordToggle, pressed && styles.pressed]}
      >
        <Ionicons
          name={visible ? 'eye-off-outline' : 'eye-outline'}
          size={21}
          color={colors.textTertiary}
        />
      </Pressable>
    </View>
  );
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <View style={styles.errorNotice}>
      <Text style={styles.errorNoticeText}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: 'transparent' },
  brandPanel: {
    width: '44%',
    overflow: 'hidden',
    backgroundColor: '#101B2D',
  },
  brandContent: {
    flex: 1,
    paddingHorizontal: 52,
    paddingVertical: 56,
    justifyContent: 'space-between',
  },
  brandTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  brandMark: {
    width: 38,
    height: 46,
    shadowColor: '#000000',
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 1 },
  },
  brandName: { color: '#FFFFFF', fontSize: 17, fontWeight: '600', letterSpacing: 0.2 },
  captionStage: { maxWidth: 430 },
  liveLabel: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 26 },
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#E0635C' },
  liveLabelText: { color: 'rgba(255,255,255,0.55)', fontSize: 12, fontWeight: '600', letterSpacing: 1.68, textTransform: 'uppercase' },
  captionPair: { marginBottom: 22 },
  captionEnglishRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap' },
  captionEnglish: { color: '#F4F7FB', fontSize: 21, lineHeight: 30.5, fontWeight: '500' },
  captionChinese: { color: '#8FA8C8', fontSize: 15, lineHeight: 24, fontWeight: '400', marginTop: 5 },
  captionCursor: { width: 2, height: 21, backgroundColor: '#FFFFFF', marginLeft: 5 },
  brandTagline: { color: 'rgba(255,255,255,0.85)', fontSize: 13.5, lineHeight: 21.6, fontWeight: '600' },
  brandDescription: { color: 'rgba(255,255,255,0.50)', fontSize: 13.5, lineHeight: 21.6, marginTop: 1 },
  authArea: { flex: 1, backgroundColor: 'transparent' },
  keyboardAvoider: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 40,
    paddingVertical: 48,
  },
  content: { width: '100%', maxWidth: 420, alignSelf: 'center' },
  loginCard: { width: '100%' },
  card: { width: '100%', gap: 16 },
  entryView: { gap: 16 },
  headerCopy: { marginBottom: 14 },
  cardTitle: { color: '#16243A', fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.4 },
  authSwitchRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  cardSubtitle: { color: '#3D4D66', fontSize: 14.5, lineHeight: 21 },
  authSwitchLink: { color: '#334B68', fontSize: 14.5, lineHeight: 21, fontWeight: '600' },
  ssoStack: { gap: 11, marginBottom: 8 },
  ssoButton: { height: 50, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  appleButton: { backgroundColor: '#000000', borderWidth: 1, borderColor: '#000000' },
  appleButtonText: { color: '#FFFFFF', fontSize: 15.5, fontWeight: '600' },
  googleButton: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E3E8EF' },
  googleButtonText: { color: '#16243A', fontSize: 15.5, fontWeight: '600' },
  ssoPressed: { opacity: 0.92, transform: [{ scale: 0.99 }] },
  emailDivider: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 8 },
  dividerLine: { flex: 1, height: 1, backgroundColor: '#E3E8EF' },
  dividerText: { color: '#9AA7B8', fontSize: 12.5, fontWeight: '500' },
  fieldGroup: { gap: 7 },
  label: { color: '#3D4D66', fontSize: 13, fontWeight: '600' },
  input: {
    height: 50,
    borderWidth: 1,
    borderColor: '#E3E8EF',
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 16,
    fontSize: 15.5,
    color: '#16243A',
    letterSpacing: 0,
    textAlign: 'left',
  },
  inputFocused: {
    borderColor: '#334B68',
    shadowColor: '#334B68',
    shadowOpacity: 0.08,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 0 },
  },
  passwordWrap: { position: 'relative' },
  passwordInput: { letterSpacing: 0, textAlign: 'left', paddingRight: 54 },
  passwordToggle: { position: 'absolute', right: 6, top: 6, width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  codeWrap: { gap: 16 },
  codeInput: { letterSpacing: 8, textAlign: 'center' },
  error: { color: colors.recordingRed, fontSize: fontSize.sm, fontWeight: '600' },
  success: { color: '#16243A', fontSize: 12.5, fontWeight: '600', lineHeight: 19 },
  helper: { color: '#9AA7B8', fontSize: 12.5, lineHeight: 18.75, textAlign: 'center' },
  hint: { color: '#9AA7B8', fontSize: 12.5, lineHeight: 18.75 },
  primaryAction: { minHeight: 52, borderRadius: 14, backgroundColor: colors.navy },
  errorNotice: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.lg,
    backgroundColor: colors.recordingTint,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  errorNoticeText: {
    color: colors.recordingRed,
    fontSize: fontSize.sm,
    fontWeight: '600',
    lineHeight: 20,
  },
  textButton: { minHeight: 38, alignItems: 'center', justifyContent: 'center' },
  forgotButton: { alignSelf: 'flex-end', marginTop: -6, marginBottom: 4 },
  textButtonLabel: { color: '#334B68', fontSize: 13.5, fontWeight: '600' },
  guestFooter: { marginTop: 10, paddingTop: 22, borderTopWidth: 1, borderTopColor: '#E3E8EF', alignItems: 'center' },
  guestButtonLabel: { color: '#3D4D66', fontSize: 14.5, fontWeight: '600' },
  guestHelper: { color: '#9AA7B8', fontSize: 12.5, marginTop: 6 },
  pressed: { opacity: 0.78, transform: [{ scale: 0.995 }] },
});
