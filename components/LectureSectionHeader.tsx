import { Ionicons } from '@expo/vector-icons';
import { ComponentProps, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, fontSize, radius, spacing } from '@/constants/theme';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

type Props = {
  icon: IoniconName;
  label: string;
  trailing?: ReactNode;
};

/** Canonical icon-and-label header shared by every Lecture content section. */
export function LectureSectionHeader({ icon, label, trailing }: Props) {
  return (
    <View style={styles.header}>
      <View style={styles.icon}>
        <Ionicons name={icon} size={15} color={colors.textPrimary} />
      </View>
      <Text style={styles.label}>{label}</Text>
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  icon: {
    width: 30,
    height: 30,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    flexShrink: 1,
    fontSize: fontSize.xs,
    lineHeight: 15,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: colors.textSecondary,
  },
  trailing: {
    marginLeft: 'auto',
  },
});
