import 'expo-dev-client';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { colors } from '@/constants/theme';
import { AuthProvider, useAuth } from '@/lib/auth';
import { LiveCaptionsProvider } from '@/lib/liveCaptions';
import { RecordingNotesProvider } from '@/lib/recordingNotes';
import { DataProvider } from '@/lib/store';

export const unstable_settings = {
  anchor: '(tabs)',
};

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
        <AuthProvider>
          <LiveCaptionsProvider>
            <DataProvider>
              <RecordingNotesProvider>
                <AuthGate />
              </RecordingNotesProvider>
              <StatusBar style="dark" />
            </DataProvider>
          </LiveCaptionsProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
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

  return (
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
        <Stack.Screen name="recording" />
        <Stack.Screen name="mini-caption" options={{ animation: 'fade' }} />
        <Stack.Screen name="processing" />
        <Stack.Screen name="lecture/[id]" />
        <Stack.Screen name="course/[id]" />
        <Stack.Screen name="recently-deleted" />
        <Stack.Screen name="plans" />
        <Stack.Screen name="material/[id]" />
        <Stack.Screen name="lecture-material/[lectureId]/[materialId]" />
      </Stack.Protected>
    </Stack>
  );
}
