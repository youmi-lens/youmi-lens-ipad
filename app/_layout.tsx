import 'expo-dev-client';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { ComponentType } from 'react';

import { TutorialOverlay } from '@/components/TutorialOverlay';
import { TutorialTourOverlay } from '@/components/TutorialTourOverlay';
import { colors } from '@/constants/theme';
import { AuthProvider, useAuth } from '@/lib/auth';
import { useSubscriptionReconciliation } from '@/lib/useSubscriptionReconciliation';
import { I18nProvider } from '@/lib/i18n';
import { LiveCaptionsProvider } from '@/lib/liveCaptions';
import { useProcessingOrchestrator } from '@/lib/useProcessingOrchestrator';
import { RecordingNotesProvider } from '@/lib/recordingNotes';
import {
  resolveRecordingEngineOwnershipDecisionForRuntime,
  setDeveloperRecordingEngineOverride,
} from '@/lib/recording/featureGate';
import { isNativeDurableRecorderDevForceEnabled } from '@/lib/recording/nativeDurableDevForce';
import { isR6SimulatorVerifyEnabled } from '@/lib/recording/r6VerifyGate';
import { DataProvider } from '@/lib/store';
import { TutorialProvider } from '@/lib/tutorial';
import { TutorialTourProvider } from '@/lib/tutorialTour';

export const unstable_settings = {
  anchor: '(tabs)',
};

// Dev-only, opt-in: EXPO_PUBLIC_FORCE_NATIVE_DURABLE_RECORDER=1 under __DEV__
// forces the native durable recorder for physical validation. Inert in every
// other build — see lib/recording/nativeDurableDevForce.ts. This never
// touches CONFIGURED_RECORDING_ENGINE, remote rollout, or the dogfood cohort,
// all of which stay on 'legacy'.
if (isNativeDurableRecorderDevForceEnabled()) {
  setDeveloperRecordingEngineOverride('nativeDurable');
}

// Explicit, DEV-only physical-test observability. It evaluates the same single
// engine decision used by useLectureRecorder for a new lecture with no durable
// recovery media. It neither creates a session nor requests microphone access.
if (__DEV__ && process.env.EXPO_PUBLIC_RECORDING_ENGINE_DIAGNOSTIC === '1') {
  const decision = resolveRecordingEngineOwnershipDecisionForRuntime({
    hasDurableEvidence: false,
  });
  console.info('[recorder] runtime_engine_selection', {
    engine: decision.engine,
    source: decision.source,
    fallbackReason: decision.fallbackReason,
  });
}

/**
 * Root navigator for Youmi Lens for iPad.
 *
 * DataProvider holds the user's local courses and lectures. Bottom tabs
 * (Record / Courses / Settings) live under `(tabs)`; the recording flows are
 * pushed as full-screen stack routes.
 */
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <I18nProvider>
        <AuthProvider>
          <SubscriptionReconciliationHost />
          <LiveCaptionsProvider>
            <DataProvider>
              <RecordingNotesProvider>
                <ProcessingOrchestrator />
                <TutorialProvider>
                  <TutorialTourProvider>
                    <AuthGate />
                    <TutorialOverlay />
                    <TutorialTourOverlay />
                  </TutorialTourProvider>
                </TutorialProvider>
              </RecordingNotesProvider>
              <StatusBar style="dark" />
            </DataProvider>
          </LiveCaptionsProvider>
        </AuthProvider>
        </I18nProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function SubscriptionReconciliationHost() {
  useSubscriptionReconciliation();
  return null;
}

/**
 * Headless host for the durable processing orchestrator. Mounted once, inside
 * DataProvider + AuthProvider, so committed lectures keep uploading/processing
 * no matter which screen (or none) is on top. Renders nothing.
 */
function ProcessingOrchestrator() {
  useProcessingOrchestrator();
  return null;
}

/**
 * Auth gating is expressed with `Stack.Protected` guards rather than by swapping
 * the whole navigator for a `<Redirect>`. The `<Stack>` stays mounted at all
 * times, so the route that a guard redirects to (e.g. `auth`) always exists in a
 * live navigator. Returning a `<Redirect>` in place of the `<Stack>` used to
 * unmount the navigator mid-redirect, which produced the runtime warning
 * "The action 'REPLACE' with payload {name:'auth'} was not handled by any
 * navigator." during sign-out / password-reset / guest→sign-in transitions.
 *
 * Access rules preserved exactly:
 *  - Unauthenticated, non-guest users can only reach the `auth` routes.
 *  - Guests and signed-in users can reach the app; guests may still open `auth`.
 *  - A signed-in user mid password-reset or username setup stays on `auth`.
 *  - A fully signed-in user is bounced off `auth` to `/` (the `(tabs)` anchor).
 */
function AuthGate() {
  const { session, loading, isGuest, needsUsernameSetup, isResettingPassword } = useAuth();

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }}>
        <ActivityIndicator color={colors.deepNavy} />
      </View>
    );
  }

  // A signed-in user who still needs username setup (or is mid password-reset)
  // must stay on `auth`. Gating the authenticated group on those flags — rather
  // than on session alone — keeps the whole `(tabs)` navigator (and its anchor)
  // from mounting over the still-active onboarding screen, which otherwise
  // steals the text-input responder and leaves the "Choose your username" field
  // rendered but unfocusable/untypeable. auth.tsx already keeps the route on
  // `auth` in these states, so this changes nothing the user sees.
  const canUseApp = isGuest || (!!session && !needsUsernameSetup && !isResettingPassword);

  // R6 Simulator verification host must never enter the production module graph.
  // Require only when both gates pass so Metro cannot statically pull the host
  // (and its durable test hooks) into release bundles.
  let R6SimulatorVerifyHost: ComponentType | null = null;
  if (isR6SimulatorVerifyEnabled()) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    R6SimulatorVerifyHost = require('@/lib/recording/R6SimulatorVerifyHost').R6SimulatorVerifyHost;
  }

  return (
    <>
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="auth" />
      <Stack.Screen name="auth/callback" />
      <Stack.Protected guard={canUseApp}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="create-course"
          options={{
            presentation: 'transparentModal',
            animation: 'fade',
            contentStyle: { backgroundColor: 'transparent' },
          }}
        />
        {/* Disable the iOS swipe-back gesture on the recording screen: leaving
            must go through the in-app Back button so the audio segment is
            finalized (stopRecording) and the in-progress lecture is persisted.
            A raw swipe-back would unmount without finalizing the audio. */}
        <Stack.Screen name="recording" options={{ gestureEnabled: false }} />
        <Stack.Screen name="mini-caption" options={{ animation: 'fade' }} />
        <Stack.Screen name="processing" />
        <Stack.Screen name="lecture/[id]" />
        <Stack.Screen name="lecture/[id]/summary-edit" />
        <Stack.Screen name="lecture/[id]/transcript-edit" />
        <Stack.Screen name="course/[id]" />
        <Stack.Screen name="recently-deleted" />
        <Stack.Screen name="plans" />
        <Stack.Screen name="material/[id]" />
        <Stack.Screen name="lecture-material/[lectureId]/[materialId]" />
        {__DEV__ && process.env.EXPO_PUBLIC_VISUAL_FIXTURE === '1' ? <Stack.Screen name="dev-visual-fixture" /> : null}
      </Stack.Protected>
    </Stack>
    {R6SimulatorVerifyHost ? <R6SimulatorVerifyHost /> : null}
    </>
  );
}
