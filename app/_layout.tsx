import 'expo-dev-client';
import { Redirect, Stack, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { colors } from '@/constants/theme';
import { AuthProvider, useAuth } from '@/lib/auth';
import { LiveCaptionsProvider } from '@/lib/liveCaptions';
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
    <SafeAreaProvider>
      <AuthProvider>
        <LiveCaptionsProvider>
          <DataProvider>
            <AuthGate>
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.background },
              }}
            >
              <Stack.Screen name="auth" />
              <Stack.Screen name="auth/callback" />
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="create-course" options={{ presentation: 'modal' }} />
              <Stack.Screen name="recording" />
              <Stack.Screen name="mini-caption" options={{ animation: 'fade' }} />
              <Stack.Screen name="processing" />
              <Stack.Screen name="lecture/[id]" />
            </Stack>
            </AuthGate>
            <StatusBar style="dark" />
          </DataProvider>
        </LiveCaptionsProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();
  const segments = useSegments();
  const inAuthRoute = segments[0] === 'auth';

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }}>
        <ActivityIndicator color={colors.deepNavy} />
      </View>
    );
  }

  if (!session && !inAuthRoute) {
    return <Redirect href="/auth" />;
  }

  if (session && inAuthRoute) {
    return <Redirect href="/(tabs)" />;
  }

  return children;
}
