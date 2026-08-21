import { Redirect, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlassCard } from '@/components/GlassCard';
import { PrimaryButton } from '@/components/PrimaryButton';
import { colors, spacing } from '@/constants/theme';
import { VISUAL_FIXTURE_IDS } from '@/lib/devVisualFixture';

/** Explicit entry point for the entirely in-memory, DEV-only visual fixture. */
export default function DevVisualFixtureScreen() {
  const router = useRouter();
  if (!__DEV__ || process.env.EXPO_PUBLIC_VISUAL_FIXTURE !== '1') return <Redirect href="/" />;
  const go = (pathname: '/courses' | '/course/[id]' | '/recording' | '/lecture/[id]') => {
    if (pathname === '/courses') router.push('/courses');
    if (pathname === '/course/[id]') router.push({ pathname, params: { id: VISUAL_FIXTURE_IDS.course } });
    if (pathname === '/recording') router.push({ pathname, params: { courseId: VISUAL_FIXTURE_IDS.course, lectureId: VISUAL_FIXTURE_IDS.lecture } });
    if (pathname === '/lecture/[id]') router.push({ pathname, params: { id: VISUAL_FIXTURE_IDS.lecture } });
  };
  return <SafeAreaView style={styles.root}><ScrollView contentContainerStyle={styles.content}>
    <Text style={styles.title}>DEV Visual Fixture</Text><Text style={styles.body}>In-memory only. No account data, recording, upload, or cloud operation is enabled.</Text>
    <GlassCard style={styles.card}>
      <PrimaryButton label="Courses" onPress={() => go('/courses')} />
      <PrimaryButton label="Course Detail" onPress={() => go('/course/[id]')} />
      <PrimaryButton label="Recording" onPress={() => go('/recording')} />
      <PrimaryButton label="Lecture Detail" onPress={() => go('/lecture/[id]')} />
    </GlassCard>
  </ScrollView></SafeAreaView>;
}
const styles = StyleSheet.create({ root: { flex: 1, backgroundColor: colors.background }, content: { padding: spacing.xl, gap: spacing.lg }, title: { color: colors.ink, fontSize: 28, fontWeight: '800' }, body: { color: colors.textSecondary, fontSize: 15, lineHeight: 21 }, card: { gap: 12 } });
