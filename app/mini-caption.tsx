import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LogoMark } from '@/components/BrandHeader';
import { colors, fontSize, radius, shadows, spacing } from '@/constants/theme';
import { formatClock } from '@/lib/format';
import { useLiveCaptions } from '@/lib/liveCaptions';

/** Faint horizontal ruling for the faux notebook page. */
function RuledPaper() {
  return (
    <View style={styles.paper} pointerEvents="none">
      <View style={styles.margin} />
      <View style={styles.rules}>
        {Array.from({ length: 20 }).map((_, i) => (
          <View key={i} style={styles.ruleLine} />
        ))}
      </View>
    </View>
  );
}

/** A small hand-drawn-style concept diagram: Society → Values / Norms. */
function ConceptTree() {
  return (
    <View style={styles.tree}>
      <View style={styles.treeNode}>
        <Text style={styles.treeNodeText}>Society</Text>
      </View>
      <View style={styles.treeConnector} />
      <View style={styles.treeBracket} />
      <View style={styles.treeRow}>
        <View style={styles.treeLeaf}>
          <Text style={styles.treeNodeText}>Values</Text>
        </View>
        <View style={styles.treeLeaf}>
          <Text style={styles.treeNodeText}>Norms</Text>
        </View>
      </View>
    </View>
  );
}

export default function MiniCaptionScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ course?: string; elapsed?: string }>();
  const { width } = useWindowDimensions();

  const { status, error, latestCaption, partialCaption, finalCaptions } = useLiveCaptions();
  const [seconds, setSeconds] = useState(Number(params.elapsed ?? 0) || 0);
  const [paused, setPaused] = useState(false);
  const [marked, setMarked] = useState(false);

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [paused]);

  const panelWidth = Math.min(width - spacing.xl * 2, 410);

  return (
    <View style={styles.root}>
      {/* ---- Faux note-taking page (demonstrates the real use case) ---- */}
      <RuledPaper />
      <SafeAreaView style={styles.page} edges={['top', 'left', 'right', 'bottom']}>
        <ScrollView contentContainerStyle={styles.noteContent} showsVerticalScrollIndicator={false}>
          <View style={styles.noteHeaderRow}>
            <Text style={styles.noteCourse}>SOCIOLOGY 101</Text>
            <Text style={styles.noteDate}>May 7</Text>
          </View>

          <View style={styles.headingBlock}>
            <Text style={styles.noteHeading}>Social Structure</Text>
            <View style={styles.headingUnderline} />
          </View>

          <Text style={styles.noteBullet}>• Society is built from smaller parts</Text>
          <Text style={styles.noteBullet}>• The parts all work together as a whole</Text>
          <Text style={styles.noteBullet}>• Key elements — culture, values, norms</Text>

          <ConceptTree />

          <Text style={styles.noteArrow}>→ shapes how people think &amp; act</Text>
          <Text style={styles.noteBullet}>• Examples: family, school, media</Text>

          <Text style={styles.noteAside}>
            Youmi captions stay in sync while you keep writing ↗
          </Text>
        </ScrollView>
      </SafeAreaView>

      {/* ---- Floating caption overlay ---- */}
      <SafeAreaView style={styles.floatLayer} edges={['top', 'right']} pointerEvents="box-none">
        <View style={[styles.panel, { width: panelWidth }]}>
          <View style={styles.grip} />

          {/* Brand + close */}
          <View style={styles.panelHeader}>
            <View style={styles.panelBrand}>
              <LogoMark size={22} onNavy />
              <Text style={styles.panelTitle}>Youmi Lens</Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close mini caption"
              onPress={() => router.back()}
              hitSlop={10}
              style={({ pressed }) => [styles.closeBtn, pressed && styles.pressed]}
            >
              <Ionicons name="close" size={16} color={colors.textOnNavyMuted} />
            </Pressable>
          </View>

          {/* Recording status + timer */}
          <View style={styles.liveRow}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>{paused ? 'PAUSED' : 'RECORDING'}</Text>
            <Text style={styles.liveTimer}>{formatClock(seconds)}</Text>
          </View>

          <View style={styles.notConnected}>
            <View style={styles.notConnectedIcon}>
              <Ionicons
                name={status === 'active' ? 'chatbubble-ellipses' : 'chatbubble-ellipses-outline'}
                size={20}
                color={colors.iceBlue}
              />
            </View>
            <Text style={styles.ncStatus}>
              {status === 'active'
                ? 'Live captions active'
                : status === 'listening'
                  ? 'Listening for speech…'
                  : status === 'connecting'
                    ? 'Connecting…'
                    : 'Unavailable'}
            </Text>
            <Text style={styles.ncEn}>
              {partialCaption || latestCaption || error || 'Listening for speech…'}
            </Text>
            {finalCaptions.length > 0 ? (
              <View style={styles.miniHistory}>
                {finalCaptions.slice(-3).map((caption, index) => (
                  <Text key={`${caption}-${index}`} style={styles.miniHistoryLine}>
                    {caption}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>

          {/* Compact controls */}
          <View style={styles.panelActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Mark important"
              onPress={() => setMarked((m) => !m)}
              style={({ pressed }) => [
                styles.panelBtn,
                marked && styles.panelBtnActive,
                pressed && styles.pressed,
              ]}
            >
              <Ionicons
                name={marked ? 'star' : 'star-outline'}
                size={19}
                color={marked ? colors.deepNavy : colors.textOnNavy}
              />
              <Text style={[styles.panelBtnLabel, marked && styles.panelBtnLabelActive]}>
                Mark
              </Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Expand to full recording"
              onPress={() => router.back()}
              style={({ pressed }) => [styles.panelBtn, pressed && styles.pressed]}
            >
              <Ionicons name="scan-outline" size={19} color={colors.textOnNavy} />
              <Text style={styles.panelBtnLabel}>Expand</Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={paused ? 'Resume' : 'Pause'}
              onPress={() => setPaused((p) => !p)}
              style={({ pressed }) => [styles.panelBtn, pressed && styles.pressed]}
            >
              <Ionicons
                name={paused ? 'play' : 'pause'}
                size={19}
                color={colors.textOnNavy}
              />
              <Text style={styles.panelBtnLabel}>{paused ? 'Resume' : 'Pause'}</Text>
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

const MARGIN_X = 66;

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.paper,
  },

  // ---- Notebook background ----
  paper: {
    ...StyleSheet.absoluteFillObject,
  },
  margin: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: MARGIN_X,
    width: 2,
    backgroundColor: colors.noteMargin,
  },
  rules: {
    position: 'absolute',
    top: 132,
    left: 0,
    right: 0,
  },
  ruleLine: {
    height: 1,
    backgroundColor: colors.noteLine,
    marginBottom: 39,
  },
  page: {
    flex: 1,
  },
  noteContent: {
    paddingLeft: MARGIN_X + spacing.xl,
    paddingRight: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xxxl,
  },
  noteHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  noteCourse: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 1.4,
    color: colors.mutedBlueGray,
  },
  noteDate: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.mutedBlueGray,
  },
  headingBlock: {
    alignSelf: 'flex-start',
    marginBottom: spacing.xl,
    transform: [{ rotate: '-1.2deg' }],
  },
  noteHeading: {
    fontSize: fontSize.xxl,
    fontWeight: '700',
    color: colors.secondaryNavy,
  },
  headingUnderline: {
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.iceBlue,
    marginTop: 4,
  },
  noteBullet: {
    fontSize: fontSize.lg,
    color: colors.textSecondary,
    fontWeight: '500',
    marginBottom: spacing.lg,
  },
  noteArrow: {
    fontSize: fontSize.md,
    color: colors.mutedBlueGray,
    fontWeight: '600',
    marginLeft: spacing.xl,
    marginBottom: spacing.lg,
  },
  noteAside: {
    fontSize: fontSize.sm,
    color: colors.textTertiary,
    fontStyle: 'italic',
    marginTop: spacing.lg,
  },

  // ---- Concept diagram ----
  tree: {
    alignSelf: 'flex-start',
    alignItems: 'center',
    marginVertical: spacing.lg,
    transform: [{ rotate: '0.7deg' }],
  },
  treeNode: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderWidth: 1.5,
    borderColor: colors.mutedBlueGray,
    borderRadius: radius.pill,
    backgroundColor: colors.paper,
  },
  treeLeaf: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderWidth: 1.5,
    borderColor: colors.mutedBlueGray,
    borderRadius: radius.pill,
    backgroundColor: colors.paper,
  },
  treeNodeText: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.secondaryNavy,
  },
  treeConnector: {
    width: 2,
    height: 13,
    backgroundColor: colors.mutedBlueGray,
  },
  treeBracket: {
    width: 116,
    height: 15,
    borderColor: colors.mutedBlueGray,
    borderTopWidth: 2,
    borderLeftWidth: 2,
    borderRightWidth: 2,
    borderTopLeftRadius: 5,
    borderTopRightRadius: 5,
  },
  treeRow: {
    width: 196,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },

  // ---- Floating panel ----
  floatLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'flex-end',
    padding: spacing.xl,
  },
  panel: {
    backgroundColor: colors.deepNavy,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.14)',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    ...shadows.float,
  },
  grip: {
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
    alignSelf: 'center',
    marginBottom: spacing.md,
  },
  panelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  panelBrand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  panelTitle: {
    color: colors.textOnNavy,
    fontSize: fontSize.md,
    fontWeight: '700',
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.navyElevated,
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg,
    marginBottom: spacing.lg,
    paddingBottom: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.navyBorder,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.recordingRed,
  },
  liveText: {
    flex: 1,
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 1,
    color: colors.textOnNavyMuted,
  },
  liveTimer: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.textOnNavy,
    fontVariant: ['tabular-nums'],
  },
  notConnected: {
    alignItems: 'flex-start',
    paddingTop: spacing.lg,
  },
  notConnectedIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    backgroundColor: colors.navyElevated,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  ncStatus: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 0.7,
    color: colors.textOnNavyMuted,
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
  },
  ncEn: {
    fontSize: fontSize.lg,
    lineHeight: fontSize.lg * 1.4,
    fontWeight: '600',
    color: colors.textOnNavy,
  },
  miniHistory: {
    gap: spacing.sm,
    marginTop: spacing.lg,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.navyBorder,
  },
  miniHistoryLine: {
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * 1.45,
    fontWeight: '500',
    color: colors.textOnNavyMuted,
  },
  panelActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xl,
  },
  panelBtn: {
    flex: 1,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.navyElevated,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  panelBtnActive: {
    backgroundColor: colors.iceBlue,
  },
  panelBtnLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textOnNavyMuted,
  },
  panelBtnLabelActive: {
    color: colors.deepNavy,
  },
  pressed: {
    opacity: 0.7,
    transform: [{ scale: 0.96 }],
  },
});
