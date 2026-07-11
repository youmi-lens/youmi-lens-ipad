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
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

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
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable style={styles.backdrop} onPress={onCancel} />
        <View style={styles.card}>
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
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(6, 27, 52, 0.38)',
  },
  card: {
    width: 360,
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: spacing.xl,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.card,
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
