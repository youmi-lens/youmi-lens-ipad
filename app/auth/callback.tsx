import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, fontSize, spacing } from '@/constants/theme';
import { applySessionFromCallbackUrl, useAuth } from '@/lib/auth';

export default function AuthCallbackScreen() {
  const router = useRouter();
  const incomingUrl = Linking.useURL();
  const { refreshSession } = useAuth();
  const [message, setMessage] = useState('Completing sign in…');

  useEffect(() => {
    let active = true;

    const finishCallback = async () => {
      const url = incomingUrl ?? (await Linking.getInitialURL());
      if (url) {
        await applySessionFromCallbackUrl(url);
      }

      const session = await refreshSession();
      if (!active) return;

      if (session) {
        router.replace('/');
        return;
      }

      setMessage('We could not complete the app callback. Return to Youmi Lens and try the email link again.');
    };

    finishCallback();

    return () => {
      active = false;
    };
  }, [incomingUrl, refreshSession, router]);

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.content}>
        <ActivityIndicator color={colors.deepNavy} />
        <Text style={styles.message}>{message}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    paddingHorizontal: spacing.xl,
  },
  message: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    textAlign: 'center',
  },
});
