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
import { sendSignupCode, verifySignupCodeAndCreateUser } from '@/lib/signupApi';

type EntryMode = 'createProfile' | 'signIn';
type AuthStep = 'entry' | 'signupCode' | 'signInCodeEmail' | 'signInCodeVerify';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function AuthScreen() {
  const router = useRouter();
  const { session, sendSignInCode, verifySignInCode, signInWithPassword } = useAuth();
  const [entryMode, setEntryMode] = useState<EntryMode>('signIn');
  const [step, setStep] = useState<AuthStep>('entry');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pendingEmail, setPendingEmail] = useState('');
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

  const switchMode = (nextMode: EntryMode) => {
    setEntryMode(nextMode);
    setStep('entry');
    setError(null);
    setPersistentError(null);
    setCode('');
  };

  // ── Create Profile: step 1 — send the verification code ─────────────────────
  const handleSendSignupCode = async () => {
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
    const result = await sendSignupCode(trimmedEmail, trimmedUsername);
    setBusyAction(null);

    if (!result.ok) {
      if (result.emailExists) {
        setEntryMode('signIn');
        setStep('entry');
        setPersistentError(result.message);
        return;
      }
      setError(result.message);
      return;
    }

    setPendingEmail(trimmedEmail);
    setCode('');
    setStep('signupCode');
  };

  // ── Create Profile: step 2 — verify the code, then create the account ───────
  const handleVerifyAndCreate = async () => {
    const trimmedCode = code.replace(/\s/g, '');
    if (!trimmedCode) return setError('Please enter the verification code.');
    if (!/^\d{8}$/.test(trimmedCode)) return setError('Enter the full 8-digit code.');

    setBusyAction('verify');
    setError(null);
    const result = await verifySignupCodeAndCreateUser({
      username: username.trim(),
      email: email.trim(),
      password,
      code: trimmedCode,
    });

    if (!result.ok) {
      setBusyAction(null);
      if (result.emailExists) {
        setEntryMode('signIn');
        setStep('entry');
        setPersistentError(result.message);
        return;
      }
      setError(result.message);
      return;
    }

    // Account created — sign in with the email + password the user just set.
    const { error: signInError } = await signInWithPassword(email.trim(), password);
    setBusyAction(null);
    if (signInError) {
      setEntryMode('signIn');
      setStep('entry');
      setPersistentError('Your account is ready. Please sign in with your email and password.');
      return;
    }
    router.replace('/(tabs)');
  };

  const handleResendSignupCode = async () => {
    setBusyAction('resend');
    setError(null);
    const result = await sendSignupCode(email.trim(), username.trim());
    setBusyAction(null);
    if (!result.ok) setError(result.message);
  };

  const backToCreateProfile = () => {
    setStep('entry');
    setError(null);
    setCode('');
  };

  // ── Fallback / recovery sign-in with an email verification code ─────────────
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
    router.replace('/(tabs)');
  };

  const changeEmail = () => {
    setStep('entry');
    setError(null);
    setCode('');
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
                  <Text style={styles.cardTitle}>Verify your email</Text>
                  <Text style={styles.cardSubtitle}>Enter the 8-digit code we sent to your email.</Text>
                </View>
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>Verification code</Text>
                  <TextInput
                    keyboardType="number-pad"
                    maxLength={8}
                    placeholder="12345678"
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
                  <Text style={styles.label}>Verification code</Text>
                  <TextInput
                    keyboardType="number-pad"
                    maxLength={8}
                    placeholder="12345678"
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
              <>
                <View style={styles.modeSwitch}>
                  <ModeButton label="Create Profile" active={entryMode === 'createProfile'} onPress={() => switchMode('createProfile')} />
                  <ModeButton label="Sign In" active={entryMode === 'signIn'} onPress={() => switchMode('signIn')} />
                </View>
                <View style={styles.headerCopy}>
                  <Text style={styles.cardTitle}>{entryMode === 'createProfile' ? 'Create your profile' : 'Welcome back'}</Text>
                  <Text style={styles.cardSubtitle}>
                    {entryMode === 'createProfile'
                      ? 'We’ll send a code to verify your email before creating your account.'
                      : 'Sign in with the email and password on your account.'}
                  </Text>
                  {entryMode === 'signIn' ? (
                    <Text style={styles.macHelper}>Already used Youmi Lens on Mac? Sign in with the same email.</Text>
                  ) : null}
                </View>

                {entryMode === 'createProfile' ? (
                  <>
                    <View style={styles.fieldGroup}>
                      <Text style={styles.label}>Username</Text>
                      <TextInput autoCapitalize="none" placeholder="yourname" placeholderTextColor={colors.textTertiary} style={styles.input} value={username} onChangeText={(value) => { setUsername(value); setError(null); }} />
                    </View>
                    <View style={styles.fieldGroup}>
                      <Text style={styles.label}>Email</Text>
                      <TextInput autoCapitalize="none" autoComplete="email" keyboardType="email-address" placeholder="student@example.com" placeholderTextColor={colors.textTertiary} style={styles.input} value={email} onChangeText={(value) => { setEmail(value); setError(null); setPersistentError(null); }} />
                    </View>
                    <View style={styles.fieldGroup}>
                      <Text style={styles.label}>Password</Text>
                      <TextInput autoCapitalize="none" autoComplete="new-password" secureTextEntry placeholder="Password" placeholderTextColor={colors.textTertiary} style={styles.input} value={password} onChangeText={(value) => { setPassword(value); setError(null); }} />
                    </View>
                    <View style={styles.fieldGroup}>
                      <Text style={styles.label}>Confirm Password</Text>
                      <TextInput autoCapitalize="none" autoComplete="new-password" secureTextEntry placeholder="Confirm password" placeholderTextColor={colors.textTertiary} style={styles.input} value={confirmPassword} onChangeText={(value) => { setConfirmPassword(value); setError(null); }} />
                    </View>
                  </>
                ) : (
                  <>
                    <View style={styles.fieldGroup}>
                      <Text style={styles.label}>Email</Text>
                      <TextInput autoCapitalize="none" autoComplete="email" keyboardType="email-address" placeholder="student@example.com" placeholderTextColor={colors.textTertiary} style={styles.input} value={email} onChangeText={(value) => { setEmail(value); setPersistentError(null); setError(null); }} />
                    </View>
                    <View style={styles.fieldGroup}>
                      <Text style={styles.label}>Password</Text>
                      <TextInput autoCapitalize="none" autoComplete="current-password" secureTextEntry placeholder="Password" placeholderTextColor={colors.textTertiary} style={styles.input} value={password} onChangeText={(value) => { setPassword(value); setError(null); }} />
                    </View>
                  </>
                )}

                {error ? <Text style={styles.error}>{error}</Text> : null}

                {entryMode === 'createProfile' ? (
                  <>
                    <PrimaryButton label="Send verification code" onPress={handleSendSignupCode} loading={busyAction === 'send'} disabled={busyAction !== null} />
                    <Text style={styles.helper}>We’ll verify your email before creating your account.</Text>
                    <Pressable accessibilityRole="button" onPress={() => switchMode('signIn')} style={styles.textButton}>
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
                    <Pressable accessibilityRole="button" onPress={() => switchMode('createProfile')} style={styles.textButton}>
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
