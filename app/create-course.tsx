import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { ComponentProps, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { GlassCard } from '@/components/GlassCard';
import { PrimaryButton } from '@/components/PrimaryButton';
import { colors } from '@/constants/theme';
import { COURSE_PRESETS } from '@/lib/models';
import { useT } from '@/lib/i18n';
import { useData } from '@/lib/store';

type IconName = ComponentProps<typeof Ionicons>['name'];

export default function CreateCourseScreen() {
  const t = useT();
  const router = useRouter();
  const { createCourse } = useData();
  const [name, setName] = useState('');
  const [presetIndex, setPresetIndex] = useState(0);
  const preset = COURSE_PRESETS[presetIndex];
  const canCreate = name.trim().length > 0;

  const handleCreate = () => {
    if (!canCreate) return;
    createCourse({ name: name.trim(), icon: preset.icon, tint: preset.tint, accent: preset.accent });
    router.back();
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.dim} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboard}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <GlassCard elevated padding={0} style={styles.sheet}>
            <View style={styles.sheetContent}>
              <View style={styles.header}>
                <Text style={styles.title}>{t('createCourse.title')}</Text>
                <Pressable onPress={() => router.back()} style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
                  <Ionicons name="close" size={18} color={colors.textSecondary} />
                </Pressable>
              </View>

              <View style={styles.preview}>
                <View style={[styles.previewIcon, { backgroundColor: preset.tint }]}>
                  <Ionicons name={preset.icon as IconName} size={20} color={preset.accent} />
                </View>
                <View>
                  <Text style={styles.previewName}>{name.trim() || t('createCourse.yourCourse')}</Text>
                  <Text style={styles.previewHint}>{t('createCourse.preview')}</Text>
                </View>
              </View>

              <Text style={styles.label}>{t('createCourse.name')}</Text>
              <TextInput
                autoFocus
                value={name}
                onChangeText={setName}
                onSubmitEditing={handleCreate}
                placeholder={t('createCourse.placeholder')}
                placeholderTextColor={colors.textTertiary}
                returnKeyType="done"
                style={styles.input}
                maxLength={48}
              />

              <Text style={[styles.label, styles.colorLabel]}>{t('createCourse.appearance')}</Text>
              <View style={styles.swatches}>
                {COURSE_PRESETS.map((option, index) => {
                  const selected = index === presetIndex;
                  return (
                    <Pressable
                      key={option.key}
                      onPress={() => setPresetIndex(index)}
                      style={[
                        styles.swatch,
                        { backgroundColor: option.tint },
                        selected && styles.swatchSelected,
                      ]}
                    >
                      <Ionicons name={option.icon as IconName} size={20} color={option.accent} />
                      {selected ? (
                        <View style={styles.check}><Ionicons name="checkmark" size={10} color={colors.pearlWhite} /></View>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>

              <PrimaryButton label={t('home.createCourse')} onPress={handleCreate} disabled={!canCreate} style={styles.createButton} />
            </View>
          </GlassCard>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'transparent' },
  dim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(15, 23, 42, 0.28)' },
  keyboard: { flex: 1 },
  scroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, paddingVertical: 28 },
  sheet: { width: '100%', maxWidth: 540, backgroundColor: 'rgba(255, 255, 255, 0.94)' },
  sheetContent: { paddingHorizontal: 28, paddingTop: 24, paddingBottom: 26 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.ink, fontSize: 19, fontWeight: '800' },
  close: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border },
  preview: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 14, marginTop: 16, backgroundColor: colors.surfaceMuted, borderWidth: 1, borderColor: colors.border },
  previewIcon: { width: 42, height: 42, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  previewName: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  previewHint: { color: colors.textTertiary, fontSize: 11.5, marginTop: 2 },
  label: { color: colors.textTertiary, fontSize: 11, fontWeight: '700', letterSpacing: 1, marginTop: 17, marginBottom: 7 },
  input: { height: 46, borderRadius: 12, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.glassElevated, color: colors.ink, fontSize: 14.5, fontWeight: '500' },
  colorLabel: { marginTop: 17 },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  swatch: { width: 50, height: 50, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: 'transparent' },
  swatchSelected: { borderColor: colors.navy, shadowColor: colors.navy, shadowOpacity: 0.08, shadowRadius: 8 },
  check: { position: 'absolute', top: -6, right: -6, width: 17, height: 17, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.navy },
  createButton: { marginTop: 20 },
  pressed: { opacity: 0.75, transform: [{ scale: 0.96 }] },
});
