import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ContentReveal } from '@/components/ContentReveal';
import { GlassCard } from '@/components/GlassCard';
import { PrimaryButton } from '@/components/PrimaryButton';
import { SecondaryButton } from '@/components/SecondaryButton';
import { colors, fontSize, radius, spacing } from '@/constants/theme';
import { useI18n } from '@/lib/i18n';
import { useTutorial } from '@/lib/tutorial';

/**
 * First-run tutorial — a conceptual overlay card, not a live pixel-perfect
 * spotlight. Steps reference screens the user isn't necessarily on right now
 * (e.g. "Recording" while sitting on the Courses tab), so real coach-mark
 * target measurement across screens would be fragile and would require
 * either navigating the user through real screens mid-tour (risking trapped
 * navigation / accidental state changes) or measuring elements that aren't
 * mounted. A centered card that explains the concept is the documented,
 * intentional fallback for exactly this situation.
 *
 * Rendered via a native `Modal` (the same overlay idiom Settings already
 * uses for its language sheets) so closing it is a real unmount — no
 * lingering transparent view can intercept touches afterward.
 */
export function TutorialOverlay() {
  const { t } = useI18n();
  const { visible, steps, stepIndex, next, back, closeTutorial } = useTutorial();

  if (!visible) return null;

  const step = steps[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = Boolean(step.isFinal) || stepIndex === steps.length - 1;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={closeTutorial}>
      <SafeAreaView style={styles.scrim} edges={['top', 'bottom', 'left', 'right']}>
        <View style={styles.centerWrap}>
          <ContentReveal revealKey={stepIndex} style={styles.cardWrap}>
            <GlassCard elevated padding={0} style={styles.card}>
              <View style={styles.cardInner}>
                <View style={styles.topRow}>
                  <View style={styles.progressRow}>
                    {steps.map((s, i) => (
                      <View key={s.id} style={[styles.dot, i === stepIndex && styles.dotActive]} />
                    ))}
                  </View>
                  {!isLast ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('tutorial.skip')}
                      onPress={closeTutorial}
                      hitSlop={8}
                    >
                      <Text style={styles.skipText}>{t('tutorial.skip')}</Text>
                    </Pressable>
                  ) : null}
                </View>

                <Text style={styles.title}>{t(step.titleKey)}</Text>
                <Text style={styles.body}>{t(step.bodyKey)}</Text>

                <View style={styles.actionsRow}>
                  {!isFirst ? (
                    <SecondaryButton label={t('tutorial.back')} onPress={back} style={styles.backBtn} />
                  ) : (
                    <View style={styles.backBtnSpacer} />
                  )}
                  <PrimaryButton
                    label={isLast ? t('tutorial.finishCta') : t('tutorial.next')}
                    onPress={isLast ? closeTutorial : next}
                    style={styles.nextBtn}
                  />
                </View>
              </View>
            </GlassCard>
          </ContentReveal>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(11, 19, 38, 0.55)',
  },
  centerWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  cardWrap: {
    width: '100%',
    maxWidth: 420,
  },
  card: {
    borderRadius: radius.xl,
    overflow: 'hidden',
  },
  cardInner: {
    padding: spacing.xl,
    gap: spacing.md,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 24,
  },
  progressRow: {
    flexDirection: 'row',
    gap: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.border,
  },
  dotActive: {
    backgroundColor: colors.deepNavy,
    width: 16,
  },
  skipText: {
    color: colors.textTertiary,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  title: {
    color: colors.ink,
    fontSize: fontSize.xxl,
    fontWeight: '800',
  },
  body: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    lineHeight: fontSize.md * 1.5,
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  backBtn: {
    flex: 1,
  },
  backBtnSpacer: {
    flex: 1,
  },
  nextBtn: {
    flex: 1,
  },
});

export default TutorialOverlay;
