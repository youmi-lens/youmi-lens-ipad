import { useCallback } from 'react';
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
import { useI18n } from '@/lib/i18n';

type LectureDocumentEditorProps = {
  title: string;
  draft: string;
  onChangeDraft: (text: string) => void;
  placeholder: string;
  dirty: boolean;
  onLeave: () => void;
  onPersist: () => void;
  emptyConfirmTitle: string;
  emptyConfirmBody: string;
  /** When lecture/params are missing — show not-found chrome only. */
  missing?: boolean;
};

/**
 * Shared Cancel / title / Save + multiline editor used by Summary and Transcript.
 */
export function LectureDocumentEditor({
  title,
  draft,
  onChangeDraft,
  placeholder,
  dirty,
  onLeave,
  onPersist,
  emptyConfirmTitle,
  emptyConfirmBody,
  missing = false,
}: LectureDocumentEditorProps) {
  const { t } = useI18n();

  const requestClose = useCallback(() => {
    if (!dirty) {
      onLeave();
      return;
    }
    Alert.alert(t('lecture.summaryDiscardTitle'), t('lecture.summaryDiscardBody'), [
      { text: t('lecture.summaryKeepEditing'), style: 'cancel' },
      {
        text: t('lecture.summaryDiscard'),
        style: 'destructive',
        onPress: onLeave,
      },
    ]);
  }, [dirty, onLeave, t]);

  const onSave = useCallback(() => {
    if (draft.trim().length === 0) {
      Alert.alert(emptyConfirmTitle, emptyConfirmBody, [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('common.save'), style: 'destructive', onPress: onPersist },
      ]);
      return;
    }
    onPersist();
  }, [draft, emptyConfirmBody, emptyConfirmTitle, onPersist, t]);

  if (missing) {
    return (
      <SafeAreaView style={styles.root} edges={['top', 'left', 'right', 'bottom']}>
        <View style={styles.missing}>
          <Text style={styles.missingText}>{t('lecture.notFound')}</Text>
          <Pressable accessibilityRole="button" onPress={onLeave} style={styles.headerBtn}>
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
            onChangeText={onChangeDraft}
            multiline
            textAlignVertical="top"
            autoCorrect
            autoCapitalize="sentences"
            scrollEnabled
            placeholder={placeholder}
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
