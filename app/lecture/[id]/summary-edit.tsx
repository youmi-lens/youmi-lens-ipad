import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppBackground } from '@/components/AppBackground';
import { colors, fontSize, spacing } from '@/constants/theme';
import { getSummarySectionLabel, resolveLectureLanguagePair } from '@/lib/contentLanguages.mjs';
import { useI18n } from '@/lib/i18n';
import {
  buildSummaryEditPatch,
  getEditableSummaryText,
  isSummaryDraftDirty,
} from '@/lib/summaryEdit.mjs';
import { useData } from '@/lib/store';

type SummaryEditSide = 'source' | 'translated';

function resolveSide(raw: string | undefined): SummaryEditSide | null {
  if (raw === 'source' || raw === 'translated') return raw;
  return null;
}

export default function SummaryEditScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string; side?: string }>();
  const { getLecture, updateLecture } = useData();
  const lecture = getLecture(params.id);
  const side = resolveSide(typeof params.side === 'string' ? params.side : undefined);

  const [draft, setDraft] = useState('');
  const seededRef = useRef(false);
  useEffect(() => {
    if (!lecture || !side || seededRef.current) return;
    setDraft(getEditableSummaryText(lecture, side));
    seededRef.current = true;
  }, [lecture, side]);

  const title = useMemo(() => {
    if (!lecture || !side) return t('lecture.summaryEditTitle');
    const { sourceLanguage, translationLanguage } = resolveLectureLanguagePair(lecture);
    const language = side === 'source' ? sourceLanguage : translationLanguage;
    return getSummarySectionLabel(language);
  }, [lecture, side, t]);

  const contentLanguage = useMemo(() => {
    if (!lecture || !side) return 'en';
    const { sourceLanguage, translationLanguage } = resolveLectureLanguagePair(lecture);
    return side === 'source' ? sourceLanguage : translationLanguage;
  }, [lecture, side]);

  const dirty = lecture && side ? isSummaryDraftDirty(lecture, side, draft) : false;
  const emptyConfirmTitle =
    contentLanguage === 'zh-Hans' ? t('lecture.summarySaveEmptyZh') : t('lecture.summarySaveEmptyEn');

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
    else if (params.id) router.replace({ pathname: '/lecture/[id]', params: { id: params.id } });
    else router.replace('/');
  }, [params.id, router]);

  const requestClose = useCallback(() => {
    if (!dirty) {
      leave();
      return;
    }
    Alert.alert(t('lecture.summaryDiscardTitle'), t('lecture.summaryDiscardBody'), [
      { text: t('lecture.summaryKeepEditing'), style: 'cancel' },
      {
        text: t('lecture.summaryDiscard'),
        style: 'destructive',
        onPress: leave,
      },
    ]);
  }, [dirty, leave, t]);

  const persist = useCallback(() => {
    if (!lecture || !side) return;
    updateLecture(lecture.id, buildSummaryEditPatch(lecture, side, draft));
    leave();
  }, [draft, leave, lecture, side, updateLecture]);

  const onSave = useCallback(() => {
    if (!lecture || !side) return;
    if (draft.trim().length === 0) {
      Alert.alert(emptyConfirmTitle, t('lecture.summarySaveEmptyBody'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('common.save'), style: 'destructive', onPress: persist },
      ]);
      return;
    }
    persist();
  }, [draft, emptyConfirmTitle, lecture, persist, side, t]);

  if (!lecture || !side) {
    return (
      <SafeAreaView style={styles.root} edges={['top', 'left', 'right', 'bottom']}>
        <View style={styles.missing}>
          <Text style={styles.missingText}>{t('lecture.notFound')}</Text>
          <Pressable accessibilityRole="button" onPress={leave} style={styles.headerBtn}>
            <Text style={styles.headerBtnText}>{t('common.cancel')}</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.root}>
      <AppBackground />
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right', 'bottom']}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={8}
        >
          <View style={styles.header}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('common.cancel')}
              onPress={requestClose}
              style={({ pressed }) => [styles.headerBtn, pressed && styles.pressed]}
            >
              <Text style={styles.headerBtnText}>{t('common.cancel')}</Text>
            </Pressable>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {title}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('common.save')}
              onPress={onSave}
              style={({ pressed }) => [styles.headerBtn, styles.headerBtnEnd, pressed && styles.pressed]}
            >
              <Text style={[styles.headerBtnText, styles.saveText]}>{t('common.save')}</Text>
            </Pressable>
          </View>

          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            multiline
            textAlignVertical="top"
            autoCorrect
            autoCapitalize="sentences"
            scrollEnabled
            placeholder={t('lecture.summaryEditPlaceholder')}
            placeholderTextColor={colors.textTertiary}
          />
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  safe: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.glassEdge,
    gap: spacing.sm,
  },
  headerBtn: {
    minWidth: 72,
    paddingVertical: spacing.sm,
  },
  headerBtnEnd: { alignItems: 'flex-end' },
  headerBtnText: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  saveText: { color: colors.deepNavy, fontWeight: '700' },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.textPrimary,
    letterSpacing: 0.3,
  },
  input: {
    flex: 1,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    marginBottom: spacing.lg,
    padding: spacing.xl,
    borderRadius: 18,
    backgroundColor: colors.glassElevated,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.glassEdge,
    fontSize: fontSize.lg,
    lineHeight: fontSize.lg * 1.55,
    color: colors.textPrimary,
    fontWeight: '500',
  },
  missing: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  missingText: {
    fontSize: fontSize.lg,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  pressed: { opacity: 0.72 },
});
