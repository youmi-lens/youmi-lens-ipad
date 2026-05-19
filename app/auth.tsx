import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlassCard } from '@/components/GlassCard';
import { PrimaryButton } from '@/components/PrimaryButton';
import { SecondaryButton } from '@/components/SecondaryButton';
import { colors, fontSize, layout, radius, spacing } from '@/constants/theme';
import { useAuth } from '@/lib/auth';

type EntryMode = 'createProfile' | 'signIn';
type AuthStep = 'entry' | 'signupCode' | 'signInCodeEmail' | 'signInCodeVerify';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, '');
const EXISTING_ACCOUNT_MESSAGE = 'This email already has a Youmi Lens account. Please sign in or use an email verification code.';

export default function AuthScreen() {
  const router = useRouter();
  const {
    session,
    createProfileWithPassword,
    resendSignupCode,
    sendSignInCode,
    verifySignupCodeAndCreateProfile,
    verifySignInCode,
    signInWithPassword,
    savePendingUsername,
    clearPendingUsername,
  } = useAuth();
  const [entryMode, setEntryMode] = useState<EntryMode>('signIn');
  const [step, setStep] = useState<AuthStep>('entry');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pendingEmail, setPendingEmail] = useState('');
  const [pendingUsername, setPendingUsername] = useState('');
  const [createProfileStartedAt, setCreateProfileStartedAt] = useState<number | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [persistentError, setPersistentError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'send' | 'verify' | 'signin' | 'resend' | null>(null);

  if (session) router.replace('/(tabs)');

  const validateEmail = (value: string) => {
    if (!value.trim()) return 'Please enter your email.';
    if (!EMAIL_PATTERN.test(value.trim())) return 'Please enter a valid email address.';
    return null;
  };

  const switchMode = async (nextMode: EntryMode) => {
    setEntryMode(nextMode);
    setStep('entry');
    setError(null);
    setPersistentError(null);
    setCode('');
    if (nextMode === 'signIn') await clearPendingUsername();
  };

  const handleCreateProfile = async () => {
    const trimmedUsername = username.trim();
    const trimmedEmail = email.trim();

    if (!trimmedUsername) return setError('Please enter a username.');
    if (trimmedUsername.length < 2 || trimmedUsername.length > 32) {
      return setError('Username must be 2–32 characters.');
    }
    const emailError = validateEmail(trimmedEmail);
    if (emailError) return setError(emailError);
    if (!password) return setError('Please enter a password.');
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    if (!confirmPassword) return setError('Please confirm your password.');
    if (password !== confirmPassword) return setError('Passwords do not match.');

    setBusyAction('send');
    setError(null);
    setPersistentError(null);

    if (!API_BASE_URL) {
      setBusyAction(null);
      setError('Account creation is temporarily unavailable. Missing API configuration.');
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/check-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as { exists?: boolean };
      if (payload.exists) {
        setBusyAction(null);
        setEntryMode('signIn');
        setPersistentError(EXISTING_ACCOUNT_MESSAGE);
        await clearPendingUsername();
        return;
      }
    } catch (checkError) {
      console.warn('[auth] unable to check existing account before signup', checkError);
      setBusyAction(null);
      setError('Could not verify whether this email is available. Please try again.');
      return;
    }

    await savePendingUsername(trimmedUsername);
    const startedAt = Date.now();
    const { error: createError, session: nextSession } = await createProfileWithPassword(trimmedEmail, password, trimmedUsername);
    setBusyAction(null);

    if (createError) {
      await clearPendingUsername();
      setError(createError);
      return;
    }

    if (nextSession) {
      router.replace('/(tabs)');
      return;
    }

    setPendingEmail(trimmedEmail);
    setPendingUsername(trimmedUsername);
    setCreateProfileStartedAt(startedAt);
    setCode('');
    setStep('signupCode');
  };

  const handleVerifySignup = async () => {
    const trimmedCode = code.replace(/\s/g, '');
    if (!trimmedCode) return setError('Please enter the verification code.');
    if (!/^\d+$/.test(trimmedCode)) return setError('Verification code must contain only digits.');
    if (trimmedCode.length < 8) return setError('Enter the full 8-digit code.');
    if (trimmedCode.length > 8) return setError('Verification code must be 8 digits.');

    setBusyAction('verify');
    setError(null);
    const { error: verifyError, session: nextSession } = await verifySignupCodeAndCreateProfile(
      pendingEmail,
      trimmedCode,
      pendingUsername,
      createProfileStartedAt ?? Date.now(),
    );
    setBusyAction(null);

    if (verifyError) {
      if (verifyError === EXISTING_ACCOUNT_MESSAGE) {
        setPersistentError(EXISTING_ACCOUNT_MESSAGE);
        setEntryMode('signIn');
        setStep('entry');
        setPendingUsername('');
        setCreateProfileStartedAt(null);
      }
      setError(verifyError);
      return;
    }

    setCreateProfileStartedAt(null);
    if (nextSession) router.replace('/(tabs)');
  };

  const openVerificationCodeSignIn = () => {
    setStep('signInCodeEmail');
    setError(null);
    setPersistentError(null);
    setCode('');
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
    if (!/^\d+$/.test(trimmedCode)) return setError('Verification code must contain only digits.');
    if (trimmedCode.length < 8) return setError('Enter the full 8-digit code.');
    if (trimmedCode.length > 8) return setError('Verification code must be 8 digits.');

    setBusyAction('verify');
    setError(null);
    const { error: verifyError, session: nextSession } = await verifySignInCode(pendingEmail, trimmedCode);
    setBusyAction(null);
    if (verifyError) {
      setError(verifyError);
      return;
    }

    if (nextSession) router.replace('/(tabs)');
  };

  const handleResendCode = async () => {
    setBusyAction('resend');
    setError(null);
    const resend = step === 'signInCodeVerify' ? sendSignInCode : resendSignupCode;
    const { error: resendError } = await resend(pendingEmail);
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
    router.replace('/(tabs)');
  };

  const changeEmail = async () => {
    setStep('entry');
    setError(null);
    setCode('');
    setCreateProfileStartedAt(null);
    await clearPendingUsername();
  };

  return (
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.keyboardAvoider}>
        <View style={styles.content}>
          <View style={styles.brandBlock}>
            <View style={styles.logo}><Text style={styles.logoText}>Y</Text></View>
            <Text style={styles.title}>Youmi Lens</Text>
            <Text style={styles.subtitle}>
              {step === 'signupCode'
                ? 'Verify your email to finish creating your profile.'
                : step === 'signInCodeEmail' || step === 'signInCodeVerify'
                  ? 'Sign in with an email verification code.'
                  : 'A calm lecture workspace for iPad.'}
            </Text>
          </View>

          <GlassCard padding={spacing.xl} style={styles.card}>
            {step === 'signupCode' ? (
              <View style={styles.codeWrap}>
                <View style={styles.headerCopy}>
                  <Text style={styles.cardTitle}>Check your email</Text>
                  <Text style={styles.cardSubtitle}>Enter the 8-digit code we sent to your email.</Text>
                </View>
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>Code</Text>
                  <TextInput
                    keyboardType="number-pad"
                    maxLength={8}
                    placeholder="12345678"
                    placeholderTextColor={colors.textTertiary}
                    style={[styles.input, styles.codeInput]}
                    value={code}
                    onChangeText={(value) => setCode(value.replace(/\s/g, ''))}
                  />
                </View>
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <PrimaryButton label="Verify and create account" onPress={handleVerifySignup} loading={busyAction === 'verify'} disabled={busyAction !== null} />
                <SecondaryButton label="Resend code" tone="ice" onPress={handleResendCode} disabled={busyAction !== null} />
                <Pressable accessibilityRole="button" onPress={changeEmail} style={styles.textButton}>
                  <Text style={styles.textButtonLabel}>Change email</Text>
                </Pressable>
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
                  <Text style={styles.cardSubtitle}>Enter the 8-digit code we sent to your email.</Text>
                </View>
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>Code</Text>
                  <TextInput
                    keyboardType="number-pad"
                    maxLength={8}
                    placeholder="12345678"
                    placeholderTextColor={colors.textTertiary}
                    style={[styles.input, styles.codeInput]}
                    value={code}
                    onChangeText={(value) => setCode(value.replace(/\s/g, ''))}
                  />
                </View>
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <PrimaryButton label="Verify and sign in" onPress={handleVerifySignInCode} loading={busyAction === 'verify'} disabled={busyAction !== null} />
                <SecondaryButton label="Resend code" tone="ice" onPress={handleResendCode} disabled={busyAction !== null} />
                <Pressable accessibilityRole="button" onPress={changeEmail} style={styles.textButton}>
                  <Text style={styles.textButtonLabel}>Back to password sign in</Text>
                </Pressable>
              </View>
            ) : (
              <>
                <View style={styles.modeSwitch}>
                  <ModeButton label="Create Profile" active={entryMode === 'createProfile'} onPress={() => void switchMode('createProfile')} />
                  <ModeButton label="Sign In" active={entryMode === 'signIn'} onPress={() => void switchMode('signIn')} />
                </View>
                <View style={styles.headerCopy}>
                  <Text style={styles.cardTitle}>{entryMode === 'createProfile' ? 'Create profile' : 'Welcome back'}</Text>
                  <Text style={styles.cardSubtitle}>
                    {entryMode === 'createProfile'
                      ? 'Create your account with email and password.'
                      : 'Sign in with the email and password on your account.'}
                  </Text>
                  {entryMode === 'signIn' ? (
                    <Text style={styles.macHelper}>Already used Youmi Lens on Mac? Sign in with the same email.</Text>
                  ) : null}
                </View>
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>Email</Text>
                  <TextInput autoCapitalize="none" autoComplete="email" keyboardType="email-address" placeholder="student@example.com" placeholderTextColor={colors.textTertiary} style={styles.input} value={email} onChangeText={(value) => { setEmail(value); setPersistentError(null); }} />
                </View>
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>Password</Text>
                  <TextInput autoCapitalize="none" autoComplete={entryMode === 'createProfile' ? 'new-password' : 'current-password'} secureTextEntry placeholder="Password" placeholderTextColor={colors.textTertiary} style={styles.input} value={password} onChangeText={setPassword} />
                </View>
                {entryMode === 'createProfile' ? (
                  <>
                    <View style={styles.fieldGroup}>
                      <Text style={styles.label}>Confirm Password</Text>
                      <TextInput autoCapitalize="none" autoComplete="new-password" secureTextEntry placeholder="Confirm password" placeholderTextColor={colors.textTertiary} style={styles.input} value={confirmPassword} onChangeText={setConfirmPassword} />
                    </View>
                    <View style={styles.fieldGroup}>
                      <Text style={styles.label}>Username</Text>
                      <TextInput autoCapitalize="none" placeholder="yourname" placeholderTextColor={colors.textTertiary} style={styles.input} value={username} onChangeText={setUsername} />
                    </View>
                  </>
                ) : null}
                {error ? <Text style={styles.error}>{error}</Text> : null}
                {entryMode === 'createProfile' ? (
                  <>
                    <PrimaryButton label="Create profile" onPress={handleCreateProfile} loading={busyAction === 'send'} disabled={busyAction !== null} />
                    <Text style={styles.helper}>Already have an account? Sign in instead.</Text>
                    <Pressable accessibilityRole="button" onPress={() => void switchMode('signIn')} style={styles.textButton}>
                      <Text style={styles.textButtonLabel}>Already have an account? Sign in</Text>
                    </Pressable>
                  </>
                ) : (
                  <>
                    <PrimaryButton label="Sign in" onPress={handleSignIn} loading={busyAction === 'signin'} disabled={busyAction !== null} />
                    <Text style={styles.helper}>Forgot password or don’t have one?</Text>
                    <Pressable accessibilityRole="button" onPress={openVerificationCodeSignIn} style={styles.textButton}>
                      <Text style={styles.textButtonLabel}>Email verification code</Text>
                    </Pressable>
                    <Pressable accessibilityRole="button" onPress={() => void switchMode('createProfile')} style={styles.textButton}>
                      <Text style={styles.textButtonLabel}>Create profile</Text>
                    </Pressable>
                  </>
                )}
                {persistentError ? <ErrorNotice message={persistentError} /> : null}
              </>
            )}
          </GlassCard>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <View style={styles.errorNotice}>
      <Text style={styles.errorNoticeText}>{message}</Text>
    </View>
  );
}

function ModeButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.modeButton, active && styles.modeButtonActive, pressed && styles.pressed]}>
      <Text style={[styles.modeButtonLabel, active && styles.modeButtonLabelActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  keyboardAvoider: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.xl },
  content: { width: '100%', maxWidth: layout.content, alignSelf: 'center', gap: spacing.xxl },
  brandBlock: { alignItems: 'center', gap: spacing.sm },
  logo: { width: 72, height: 72, borderRadius: radius.pill, backgroundColor: colors.deepNavy, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.sm },
  logoText: { color: colors.textOnNavy, fontSize: fontSize.display, fontWeight: '800' },
  title: { color: colors.deepNavy, fontSize: fontSize.display, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { color: colors.textSecondary, fontSize: fontSize.md, fontWeight: '500', textAlign: 'center' },
  card: { width: '100%', gap: spacing.lg },
  modeSwitch: { flexDirection: 'row', gap: spacing.sm, padding: spacing.xs, borderRadius: radius.lg, backgroundColor: colors.surfaceMuted },
  modeButton: { flex: 1, minHeight: 46, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  modeButtonActive: { backgroundColor: colors.pearlWhite },
  modeButtonLabel: { color: colors.textSecondary, fontSize: fontSize.md, fontWeight: '700' },
  modeButtonLabelActive: { color: colors.deepNavy },
  headerCopy: { gap: spacing.xs },
  cardTitle: { color: colors.textPrimary, fontSize: fontSize.xxl, fontWeight: '800', letterSpacing: -0.3 },
  cardSubtitle: { color: colors.textSecondary, fontSize: fontSize.md, lineHeight: 21 },
  macHelper: { color: colors.deepNavy, fontSize: fontSize.sm, fontWeight: '600', lineHeight: 20 },
  fieldGroup: { gap: spacing.sm },
  label: { color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '700' },
  input: { minHeight: 56, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.lg, backgroundColor: colors.pearlWhite, paddingHorizontal: spacing.lg, fontSize: fontSize.lg, color: colors.textPrimary },
  codeWrap: { gap: spacing.lg },
  codeInput: { letterSpacing: 8, textAlign: 'center' },
  error: { color: colors.recordingRed, fontSize: fontSize.sm, fontWeight: '600' },
  helper: { color: colors.textSecondary, fontSize: fontSize.sm, textAlign: 'center' },
  errorNotice: {
    borderWidth: 1,
    borderColor: '#F2C3C3',
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
  textButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  textButtonLabel: { color: colors.deepNavy, fontSize: fontSize.md, fontWeight: '700' },
  pressed: { opacity: 0.78 },
});
