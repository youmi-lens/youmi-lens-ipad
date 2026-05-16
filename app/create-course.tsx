import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { ComponentProps, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/PrimaryButton';
import { colors, fontSize, radius, spacing } from '@/constants/theme';
import { COURSE_PRESETS } from '@/lib/models';
import { useData } from '@/lib/store';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

export default function CreateCourseScreen() {
  const router = useRouter();
  const { createCourse } = useData();

  const [name, setName] = useState('');
  const [presetIndex, setPresetIndex] = useState(0);

  const preset = COURSE_PRESETS[presetIndex];
  const canCreate = name.trim().length > 0;

  const handleCreate = () => {
    if (!canCreate) return;
    createCourse({
      name: name.trim(),
      icon: preset.icon,
      tint: preset.tint,
      accent: preset.accent,
    });
    router.back();
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>New Course</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={() => router.back()}
          hitSlop={10}
          style={({ pressed }) => [styles.closeBtn, pressed && styles.pressed]}
        >
          <Ionicons name="close" size={20} color={colors.deepNavy} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.content}>
          {/* Live preview */}
          <View style={styles.preview}>
            <View style={[styles.previewTile, { backgroundColor: preset.tint }]}>
              <Ionicons name={preset.icon as IoniconName} size={32} color={preset.accent} />
            </View>
            <Text style={styles.previewName} numberOfLines={1}>
              {name.trim() || 'Your course'}
            </Text>
            <Text style={styles.previewHint}>This is how your course will appear.</Text>
          </View>

          {/* Name */}
          <Text style={styles.label}>COURSE NAME</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Biology 200"
            placeholderTextColor={colors.textTertiary}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={handleCreate}
            maxLength={48}
          />

          {/* Colour & icon presets */}
          <Text style={[styles.label, styles.labelSpaced]}>COLOUR &amp; ICON</Text>
          <View style={styles.presetGrid}>
            {COURSE_PRESETS.map((p, i) => {
              const selected = i === presetIndex;
              return (
                <Pressable
                  key={p.key}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => setPresetIndex(i)}
                  style={[
                    styles.presetTile,
                    { backgroundColor: p.tint },
                    selected && { borderColor: p.accent },
                  ]}
                >
                  <Ionicons name={p.icon as IoniconName} size={24} color={p.accent} />
                  {selected ? (
                    <View style={[styles.presetCheck, { backgroundColor: p.accent }]}>
                      <Ionicons name="checkmark" size={11} color={colors.pearlWhite} />
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </View>

          <PrimaryButton
            label="Create Course"
            icon="add"
            onPress={handleCreate}
            disabled={!canCreate}
            style={styles.createBtn}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
  },
  headerTitle: {
    fontSize: fontSize.xl,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  closeBtn: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.85,
    transform: [{ scale: 0.96 }],
  },
  scroll: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxxl,
  },
  content: {
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
  },
  preview: {
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    marginBottom: spacing.lg,
  },
  previewTile: {
    width: 76,
    height: 76,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewName: {
    fontSize: fontSize.xl,
    fontWeight: '800',
    color: colors.textPrimary,
    marginTop: spacing.xs,
  },
  previewHint: {
    fontSize: fontSize.sm,
    color: colors.textTertiary,
    fontWeight: '500',
  },
  label: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: colors.textTertiary,
    marginBottom: spacing.sm,
  },
  labelSpaced: {
    marginTop: spacing.xl,
  },
  input: {
    minHeight: 54,
    fontSize: fontSize.lg,
    fontWeight: '600',
    color: colors.textPrimary,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    paddingHorizontal: spacing.lg,
  },
  presetGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
  },
  presetTile: {
    width: 92,
    height: 66,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  presetCheck: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createBtn: {
    marginTop: spacing.xxl,
  },
});
