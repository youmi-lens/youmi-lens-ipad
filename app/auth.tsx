import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
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
    signOut,
    isResettingPassword,
    continueAsGuest,
  } = useAuth();
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
  const [resetPassword, setResetPassword] = useState('');
  const [resetConfirmPassword, setResetConfirmPassword] = useState('');
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [signInPasswordVisible, setSignInPasswordVisible] = useState(false);
  const [createPasswordVisible, setCreatePasswordVisible] = useState(false);
  const [createConfirmPasswordVisible, setCreateConfirmPasswordVisible] = useState(false);
  const [resetPasswordVisible, setResetPasswordVisible] = useState(false);
  const [resetConfirmPasswordVisible, setResetConfirmPasswordVisible] = useState(false);
  const [busyAction, setBusyAction] = useState<'send' | 'verify' | 'signin' | 'resend' | 'updatePassword' | null>(null);

  useEffect(() => {
    if (session && !isResettingPassword && step !== 'resetNewPassword') {
      router.replace('/(tabs)');
    }
  }, [isResettingPassword, router, session, step]);

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

    const { error: createError, session: nextSession } = await createProfileWithPassword(
      trimmedEmail,
      password,
      trimmedUsername,
    );
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
      router.replace('/(tabs)');
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
    const { error: verifyError, session: nextSession } = await verifySignupCode(
      email.trim(),
      trimmedCode,
      username.trim(),
    );
    setBusyAction(null);

    if (verifyError) {
      setError(verifyError);
      return;
    }
    if (nextSession) router.replace('/(tabs)');
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

  // ── Fallback / recovery sign-in with an email verification code ─────────────
  const openVerificationCodeSignIn = () => {
    setStep('signInCodeEmail');
    setError(null);
    setPersistentError(null);
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
    router.replace('/(tabs)');
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
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.keyboardAvoider}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
        <View style={styles.content}>
          <View style={styles.brandBlock}>
            <View style={styles.logo}><Text style={styles.logoText}>Y</Text></View>
            <Text style={styles.title}>Youmi Lens</Text>
            <Text style={styles.subtitle}>
              {step === 'signupCode'
                ? 'Verify your email to finish creating your profile.'
                : step === 'signInCodeEmail' || step === 'signInCodeVerify'
                  ? 'Sign in with an email verification code.'
                  : step === 'resetEmail' || step === 'resetVerify' || step === 'resetNewPassword'
                    ? 'Reset your password with an email verification code.'
                    : 'A calm lecture workspace for iPad.'}
            </Text>
          </View>

          <GlassCard padding={spacing.xl} style={styles.card}>
            {step === 'signupCode' ? (
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
                      <PasswordInput value={password} onChangeText={(value) => { setPassword(value); setError(null); }} placeholder="Password" visible={createPasswordVisible} onToggleVisible={() => setCreatePasswordVisible((current) => !current)} textContentType="newPassword" />
                    </View>
                    <View style={styles.fieldGroup}>
                      <Text style={styles.label}>Confirm Password</Text>
                      <PasswordInput value={confirmPassword} onChangeText={(value) => { setConfirmPassword(value); setError(null); }} placeholder="Confirm password" visible={createConfirmPasswordVisible} onToggleVisible={() => setCreateConfirmPasswordVisible((current) => !current)} confirm />
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
                      <PasswordInput value={password} onChangeText={(value) => { setPassword(value); setError(null); }} placeholder="Password" visible={signInPasswordVisible} onToggleVisible={() => setSignInPasswordVisible((current) => !current)} textContentType="password" />
                    </View>
                  </>
                )}

                {error ? <Text style={styles.error}>{error}</Text> : null}

                {entryMode === 'createProfile' ? (
                  <>
                    <PrimaryButton label="Send verification code" onPress={handleCreateProfile} loading={busyAction === 'send'} disabled={busyAction !== null} />
                    <Text style={styles.helper}>We’ll email you a verification code to confirm your email.</Text>
                    <Pressable accessibilityRole="button" onPress={() => switchMode('signIn')} style={styles.textButton}>
                      <Text style={styles.textButtonLabel}>Already have an account? Sign in</Text>
                    </Pressable>
                  </>
                ) : (
                  <>
                    <PrimaryButton label="Sign in" onPress={handleSignIn} loading={busyAction === 'signin'} disabled={busyAction !== null} />
                    <Pressable accessibilityRole="button" onPress={openPasswordReset} style={styles.textButton}>
                      <Text style={styles.textButtonLabel}>Forgot password?</Text>
                    </Pressable>
                    <Pressable accessibilityRole="button" onPress={() => switchMode('createProfile')} style={styles.textButton}>
                      <Text style={styles.textButtonLabel}>New to Youmi Lens? Create profile</Text>
                    </Pressable>
                  </>
                )}
                {successMessage ? <Text style={styles.success}>{successMessage}</Text> : null}
                {persistentError ? <ErrorNotice message={persistentError} /> : null}

                <View style={styles.guestDivider}>
                  <View style={styles.guestDividerLine} />
                  <Text style={styles.guestDividerText}>or</Text>
                  <View style={styles.guestDividerLine} />
                </View>
                <Pressable
                  accessibilityRole="button"
                  onPress={handleContinueAsGuest}
                  disabled={busyAction !== null}
                  style={({ pressed }) => [styles.guestButton, pressed && styles.pressed]}
                >
                  <Text style={styles.guestButtonLabel}>Continue without account</Text>
                </Pressable>
                <Text style={styles.helper}>Guest recordings are stored only on this device.</Text>
              </>
            )}
          </GlassCard>
        </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
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
  const accessibilityLabel = visible
    ? confirm ? 'Hide confirm password' : 'Hide password'
    : confirm ? 'Show confirm password' : 'Show password';

  return (
    <View style={styles.passwordWrap}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        onFocus={onFocus}
        placeholder={placeholder}
        placeholderTextColor={colors.textTertiary}
        secureTextEntry={!visible}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete={textContentType === 'password' ? 'current-password' : textContentType === 'newPassword' ? 'new-password' : 'off'}
        textContentType={textContentType ?? 'none'}
        editable={editable}
        style={[styles.input, styles.passwordInput]}
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

function ModeButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.modeButton, active && styles.modeButtonActive, pressed && styles.pressed]}>
      <Text style={[styles.modeButtonLabel, active && styles.modeButtonLabelActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  keyboardAvoider: { flex: 1 },
  // flexGrow keeps the card vertically centered when it fits, and lets the
  // page scroll once the fields (or the keyboard) exceed the available height.
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xxxl,
  },
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
  input: { minHeight: 56, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.lg, backgroundColor: colors.pearlWhite, paddingHorizontal: spacing.lg, fontSize: fontSize.lg, color: colors.textPrimary, letterSpacing: 0, textAlign: 'left' },
  passwordWrap: { position: 'relative' },
  passwordInput: { letterSpacing: 0, textAlign: 'left', paddingRight: 54 },
  passwordToggle: { position: 'absolute', right: spacing.md, top: 0, bottom: 0, width: 40, alignItems: 'center', justifyContent: 'center' },
  codeWrap: { gap: spacing.lg },
  codeInput: { letterSpacing: 8, textAlign: 'center' },
  error: { color: colors.recordingRed, fontSize: fontSize.sm, fontWeight: '600' },
  success: { color: colors.deepNavy, fontSize: fontSize.sm, fontWeight: '700', lineHeight: 20 },
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
  guestDivider: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.xs },
  guestDividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  guestDividerText: { color: colors.textTertiary, fontSize: fontSize.sm, fontWeight: '600' },
  guestButton: {
    minHeight: 56,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  guestButtonLabel: { color: colors.deepNavy, fontSize: fontSize.lg, fontWeight: '700' },
  pressed: { opacity: 0.78 },
});
