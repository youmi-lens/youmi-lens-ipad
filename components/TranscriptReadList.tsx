import { Ionicons } from '@expo/vector-icons';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';

import { LectureSectionHeader } from '@/components/LectureSectionHeader';
import { NativeLookupText } from '@/components/NativeLookupText';
import { PressableScale } from '@/components/PressableScale';
import { useIsCompactWidth } from '@/constants/responsive';
import { colors, fontSize, radius, spacing } from '@/constants/theme';
import {
  getCachedTranscriptReadItems,
  prepareTranscriptReadItems,
} from '@/lib/transcriptChunks.mjs';

type Side = 'source' | 'translated';
type Section = { side: Side; language: string; label: string; text: string };

/**
 * Rows committed in the first batch — enough to fill the tallest transcript
 * viewport we render on, so the screen never opens as "header, one paragraph,
 * blank". Everything beyond this stays virtualized.
 */
const INITIAL_VIEWPORT_ROWS = 8;

/**
 * Skeleton line widths, in order. Sized to occupy roughly the same first
 * viewport the real rows will, so the swap is a fill-in rather than a jump.
 */
const SKELETON_LINES = [
  'full', 'medium', 'full', 'short', 'full', 'medium', 'full', 'short',
] as const;

type Props = {
  cacheKey: string;
  sourceLanguage: string;
  sourceLabel: string;
  sourceText: string;
  translatedLanguage?: string;
  translatedLabel?: string;
  translatedText?: string;
  canEdit: boolean;
  pendingText: string;
  emptyText: string;
  onEdit: (side: Side) => void;
};

function useSections({
  sourceLanguage,
  sourceLabel,
  sourceText,
  translatedLanguage,
  translatedLabel,
  translatedText,
}: Pick<Props, 'sourceLanguage' | 'sourceLabel' | 'sourceText' | 'translatedLanguage' | 'translatedLabel' | 'translatedText'>) {
  return useMemo<Section[]>(() => {
    const result: Section[] = [{ side: 'source', language: sourceLanguage, label: sourceLabel, text: sourceText }];
    if (translatedLanguage && translatedLabel !== undefined && translatedText !== undefined) {
      result.push({ side: 'translated', language: translatedLanguage, label: translatedLabel, text: translatedText });
    }
    return result;
  }, [sourceLanguage, sourceLabel, sourceText, translatedLanguage, translatedLabel, translatedText]);
}

/** Prepares virtualized rows one frame after Lecture detail first paints. */
export function TranscriptReadPrewarmer(props: Omit<Props, 'canEdit' | 'pendingText' | 'emptyText' | 'onEdit'>) {
  const sections = useSections(props);
  useEffect(() => {
    if (getCachedTranscriptReadItems(props.cacheKey)) return;
    const frame = requestAnimationFrame(() => {
      prepareTranscriptReadItems(props.cacheKey, sections);
    });
    return () => cancelAnimationFrame(frame);
  }, [props.cacheKey, sections]);
  return null;
}

export const TranscriptReadList = memo(function TranscriptReadList({
  cacheKey,
  sourceLanguage,
  sourceLabel,
  sourceText,
  translatedLanguage,
  translatedLabel,
  translatedText,
  canEdit,
  pendingText,
  emptyText,
  onEdit,
}: Props) {
  const isCompact = useIsCompactWidth();
  const sections = useSections({ sourceLanguage, sourceLabel, sourceText, translatedLanguage, translatedLabel, translatedText });
  const [prepared, setPrepared] = useState(() => ({
    sections,
    items: getCachedTranscriptReadItems(cacheKey),
  }));
  // A warm cache has nothing left to defer, so it must not flash the skeleton.
  // The rAF hand-off below exists to let the lightweight shell commit before
  // native list cells mount on a COLD open; starting at `false` unconditionally
  // meant every warm reopen — and every Summary ↔ Transcript switch — rendered
  // at least one frame of placeholder over text that was already prepared.
  const [listMountReady, setListMountReady] = useState(
    () => Boolean(getCachedTranscriptReadItems(cacheKey)),
  );
  const cachedItems = getCachedTranscriptReadItems(cacheKey);
  const items = cachedItems ?? (prepared.sections === sections ? prepared.items : undefined);

  useEffect(() => {
    // Same rule when the key changes: only drop back to the shell if the new
    // key is genuinely cold.
    setListMountReady(Boolean(getCachedTranscriptReadItems(cacheKey)));
  }, [cacheKey]);

  useEffect(() => {
    if (!items) return;
    // Commit the lightweight shell first, but do not make a warm cache wait for
    // every InteractionManager handle (including the tab's release animation).
    const frame = requestAnimationFrame(() => setListMountReady(true));
    return () => cancelAnimationFrame(frame);
  }, [items]);

  useEffect(() => {
    if (cachedItems) return;
    const frame = requestAnimationFrame(() => {
      setPrepared({ sections, items: prepareTranscriptReadItems(cacheKey, sections) });
    });
    return () => cancelAnimationFrame(frame);
  }, [cacheKey, cachedItems, sections]);

  const renderHeader = useCallback((side: Side, label: string) => (
    <PressableScale
      accessibilityRole={canEdit ? 'button' : undefined}
      accessibilityLabel={label}
      onPress={canEdit ? () => onEdit(side) : undefined}
      disabled={!canEdit}
      scaleTo={0.99}
      style={[styles.header, side === 'translated' && styles.followingHeader]}
    >
      <LectureSectionHeader
        icon={side === 'source' ? 'document-text-outline' : 'language-outline'}
        label={label}
        trailing={canEdit ? <Ionicons name="create-outline" size={16} color={colors.textTertiary} /> : null}
      />
    </PressableScale>
  ), [canEdit, onEdit]);

  const renderItem = useCallback(({ item, index }: { item: any; index: number }) => {
    if (item.type === 'header') {
      return renderHeader(item.side, item.label);
    }
    if (item.type === 'empty') {
      return (
        <View style={[styles.emptyRow, styles.sectionEnd]}>
          <Text style={styles.empty}>{canEdit ? emptyText : pendingText}</Text>
        </View>
      );
    }
    const cjk = item.language === 'zh-Hans' || item.language === 'ja' || item.language === 'ko';
    const firstInSection = items?.[index - 1]?.type === 'header';
    const lastInSection = !items?.[index + 1] || items[index + 1].type === 'header';
    return (
      <View style={[styles.chunk, firstInSection && styles.firstChunk, lastInSection && styles.sectionEnd]}>
        {item.side === 'source' ? (
          <NativeLookupText style={[styles.text, cjk && styles.cjk]}>{item.text}</NativeLookupText>
        ) : (
          <Text selectable style={[styles.text, cjk && styles.cjk]}>{item.text}</Text>
        )}
      </View>
    );
  }, [canEdit, emptyText, items, pendingText, renderHeader]);

  if (!listMountReady || !items) {
    return (
      <View style={styles.list}>
        <View style={[styles.content, isCompact && styles.contentCompact]}>
          {renderHeader('source', sourceLabel)}
          <View style={styles.skeletonBody} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {SKELETON_LINES.map((width, i) => (
              <View
                key={i}
                style={[
                  styles.skeletonLine,
                  width === 'medium' && styles.skeletonLineMedium,
                  width === 'short' && styles.skeletonLineShort,
                ]}
              />
            ))}
          </View>
        </View>
      </View>
    );
  }

  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={[styles.content, isCompact && styles.contentCompact]}
      data={items}
      keyExtractor={(item) => item.key}
      renderItem={renderItem}
      // First viewport, not first row. At 2 the list committed a header plus a
      // single paragraph, so an iPad-height viewport opened mostly empty and
      // the rest of the screen visibly trickled in one batch at a time. A
      // transcript chunk is a paragraph, so ~8 rows covers the tallest viewport
      // we render on. This is still a bounded first batch — everything past it
      // stays virtualized, and windowSize/maxToRenderPerBatch are unchanged, so
      // long-scroll behaviour is exactly as before.
      initialNumToRender={INITIAL_VIEWPORT_ROWS}
      maxToRenderPerBatch={8}
      updateCellsBatchingPeriod={32}
      windowSize={7}
      showsVerticalScrollIndicator={false}
    />
  );
});

const styles = StyleSheet.create({
  list: { flex: 1 },
  content: { width: '100%', maxWidth: 1040, alignSelf: 'center', paddingHorizontal: 38, paddingTop: spacing.sm, paddingBottom: spacing.xxxl },
  contentCompact: { paddingHorizontal: 18 },
  header: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    backgroundColor: colors.glass,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: StyleSheet.hairlineWidth * 2,
    borderLeftWidth: StyleSheet.hairlineWidth * 2,
    borderRightWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.glassEdge,
  },
  followingHeader: { marginTop: spacing.lg },
  chunk: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    backgroundColor: colors.glass,
    borderLeftWidth: StyleSheet.hairlineWidth * 2,
    borderRightWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.glassEdge,
  },
  firstChunk: { paddingTop: 0 },
  sectionEnd: {
    paddingBottom: spacing.xl,
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
  },
  emptyRow: {
    paddingHorizontal: spacing.xl,
    backgroundColor: colors.glass,
    borderLeftWidth: StyleSheet.hairlineWidth * 2,
    borderRightWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.glassEdge,
  },
  skeletonBody: {
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
    backgroundColor: colors.glass,
    borderLeftWidth: StyleSheet.hairlineWidth * 2,
    borderRightWidth: StyleSheet.hairlineWidth * 2,
    borderBottomWidth: StyleSheet.hairlineWidth * 2,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
    borderColor: colors.glassEdge,
  },
  skeletonLine: {
    width: '92%',
    height: 12,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted,
    opacity: 0.42,
  },
  skeletonLineMedium: { width: '78%' },
  skeletonLineShort: { width: '56%' },
  text: { color: colors.textPrimary, fontSize: fontSize.lg, lineHeight: 28, fontWeight: '500' },
  cjk: { lineHeight: 30 },
  empty: { color: colors.textTertiary, fontSize: fontSize.md },
});
