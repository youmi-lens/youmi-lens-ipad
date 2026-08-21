/**
 * RenameModal — a lightweight inline rename dialog.
 *
 * Soft pearl/ice background, rounded corners, Cancel + Save buttons.
 * Save is disabled when the trimmed value is empty.
 */
import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { RESPONSIVE_MODAL_ORIENTATIONS } from '@/constants/modal';
import { colors, fontSize, radius, shadows, spacing } from '@/constants/theme';
import { useT } from '@/lib/i18n';

type RenameModalProps = {
  visible: boolean;
  /** Dialog heading, e.g. "Rename Course". */
  title: string;
  /** Input field label, e.g. "Course name". */
  label: string;
  initialValue: string;
  placeholder?: string;
  onCancel: () => void;
  onSave: (value: string) => void;
};

export function RenameModal({
  visible,
  title,
  label,
  initialValue,
  placeholder = '',
  onCancel,
  onSave,
}: RenameModalProps) {
  const t = useT();
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<TextInput>(null);

  // Reset to latest initialValue every time the modal becomes visible.
  useEffect(() => {
    if (visible) setValue(initialValue);
  }, [visible, initialValue]);

  const trimmed = value.trim();
  const canSave = trimmed.length > 0;

  const handleSave = () => {
    if (!canSave) return;
    onSave(trimmed);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
      statusBarTranslucent
      presentationStyle="overFullScreen"
      supportedOrientations={RESPONSIVE_MODAL_ORIENTATIONS}
    >
      <SafeAreaView style={styles.safe} edges={['top', 'right', 'bottom', 'left']}>
        <KeyboardAvoidingView
          style={styles.overlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <Pressable style={styles.backdrop} onPress={onCancel} />
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={[styles.scrollContent, isLandscape && styles.scrollContentLandscape]}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
          <View style={[styles.card, isLandscape && styles.cardLandscape]}>
          {/* Title */}
          <Text style={styles.title}>{title}</Text>

          {/* Label + input */}
          <Text style={styles.label}>{label}</Text>
          <TextInput
            ref={inputRef}
            style={styles.input}
            value={value}
            onChangeText={setValue}
            placeholder={placeholder}
            placeholderTextColor={colors.textTertiary}
            autoFocus
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={handleSave}
            selectTextOnFocus
          />

          {/* Validation hint */}
          {value.length > 0 && !canSave ? (
            <Text style={styles.validationHint}>{t('rename.empty')}</Text>
          ) : null}

          {/* Buttons */}
          <View style={styles.buttonRow}>
            <Pressable
              accessibilityRole="button"
              onPress={onCancel}
              style={({ pressed }) => [styles.cancelBtn, pressed && styles.pressed]}
            >
              <Text style={styles.cancelLabel}>{t('common.cancel')}</Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              onPress={handleSave}
              disabled={!canSave}
              style={({ pressed }) => [
                styles.saveBtn,
                !canSave && styles.saveBtnDisabled,
                pressed && canSave && styles.pressed,
              ]}
            >
              <Text style={[styles.saveLabel, !canSave && styles.saveLabelDisabled]}>{t('common.save')}</Text>
            </Pressable>
          </View>
          </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  overlay: {
    flex: 1,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(6, 27, 52, 0.38)',
  },
  scroll: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
  },
  scrollContentLandscape: { paddingVertical: spacing.sm },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.xl,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.card,
  },
  cardLandscape: {
    maxWidth: 500,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  title: {
    fontSize: fontSize.xl,
    fontWeight: '800',
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  },
  label: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.textSecondary,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  input: {
    height: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.softIceWhite,
    paddingHorizontal: spacing.lg,
    fontSize: fontSize.lg,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  validationHint: {
    fontSize: fontSize.sm,
    color: colors.recordingRed,
    fontWeight: '500',
    marginTop: -spacing.xs,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  cancelBtn: {
    flex: 1,
    height: 50,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.pearlWhite,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelLabel: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  saveBtn: {
    flex: 1,
    height: 50,
    borderRadius: radius.lg,
    backgroundColor: colors.deepNavy,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.button,
  },
  saveBtnDisabled: {
    backgroundColor: colors.surfaceMuted,
    shadowOpacity: 0,
    elevation: 0,
  },
  saveLabel: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.textOnNavy,
  },
  saveLabelDisabled: {
    color: colors.textTertiary,
  },
  pressed: {
    opacity: 0.86,
    transform: [{ scale: 0.97 }],
  },
});

export default RenameModal;
