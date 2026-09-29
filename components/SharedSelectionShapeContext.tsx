import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

import { useT } from '@/lib/i18n';
import type { SelectionShape } from '@/lib/selectionSemantics';
import { TOOLBAR_CHIP_RADIUS, TOOLBAR_ICON_HIT_SLOP, TOOLBAR_ICON_IDLE, TOOLBAR_SELECTED } from '@/lib/sharedToolbarChrome';

export type { SelectionShape } from '@/lib/selectionSemantics';

function DefaultShapeIcon({ shape, color }: { shape: SelectionShape; color: string }) {
  return (
    <Svg width={25} height={25} viewBox="0 0 28 28">
      {shape === 'rect' ? (
        <>
          <Rect x="6" y="7" width="16" height="14" rx="2.5" stroke={color} strokeWidth={1.9} strokeDasharray="3 3" fill="none" />
          <Path d="M9 7H6v3M19 7h3v3M6 18v3h3M22 18v3h-3" stroke={color} strokeWidth={1.9} strokeLinecap="round" fill="none" />
        </>
      ) : (
        <>
          <Path d="M7.6 14.8c-2.1-4.2 2.3-8 7.1-7.3 5.7.8 8.1 5.2 5.8 9.3-2.1 3.8-7.7 5.3-11.5 2.8-1.7-1.1-2.5-2.6-1.4-4.8Z" stroke={color} strokeWidth={1.9} strokeDasharray="3.2 3.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <Path d="M8.7 19.3l-2.1 3.2" stroke={color} strokeWidth={1.7} strokeLinecap="round" fill="none" />
        </>
      )}
    </Svg>
  );
}

export function SharedSelectionShapeContext({
  shape, onChange, orientation, runPress, dragHandlerProps, renderIcon,
}: {
  shape: SelectionShape;
  onChange: (shape: SelectionShape) => void;
  orientation: 'horizontal' | 'vertical';
  runPress: (action: () => void) => void;
  dragHandlerProps: Record<string, unknown>;
  renderIcon?: (shape: SelectionShape, color: string) => ReactNode;
}) {
  const t = useT();
  return (
    <View style={orientation === 'horizontal' ? styles.horizontal : styles.vertical}>
      {(['lasso', 'rect'] as const).map((option) => {
        const active = shape === option;
        const color = active ? TOOLBAR_SELECTED : TOOLBAR_ICON_IDLE;
        return (
          <Pressable
            key={option}
            accessibilityRole="button"
            accessibilityLabel={option === 'rect' ? t('tools.rectSelection') : t('tools.lassoSelection')}
            accessibilityState={{ selected: active }}
            onPress={() => runPress(() => onChange(option))}
            hitSlop={TOOLBAR_ICON_HIT_SLOP}
            {...dragHandlerProps}
            style={({ pressed }) => [styles.button, active && styles.active, pressed && styles.pressed]}
          >
            {renderIcon ? renderIcon(option, color) : <DefaultShapeIcon shape={option} color={color} />}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  horizontal: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  vertical: { alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', gap: 10 },
  button: { width: 40, height: 40, borderRadius: TOOLBAR_CHIP_RADIUS, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'transparent' },
  active: { backgroundColor: 'rgba(95,134,232,0.14)', borderColor: 'rgba(95,134,232,0.42)' },
  pressed: { opacity: 0.7, transform: [{ scale: 0.92 }] },
});
