import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, fontSize, spacing } from '@/constants/theme';
import { applySessionFromCallbackUrl, useAuth } from '@/lib/auth';
import { useT } from '@/lib/i18n';

export default function AuthCallbackScreen() {
  const t = useT();
  const router = useRouter();
  const incomingUrl = Linking.useURL();
  const { refreshSession } = useAuth();
  const [message, setMessage] = useState(() => t('auth.completingSignIn'));

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

      setMessage(t('auth.callbackError'));
    };

    finishCallback();

    return () => {
      active = false;
    };
  }, [incomingUrl, refreshSession, router, t]);

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
