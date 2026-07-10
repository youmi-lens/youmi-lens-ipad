import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import { Text, type TextProps } from 'react-native';

import { openNativeWordLookup } from '@/lib/nativeWordLookup';

type NativeLookupTextProps = Omit<TextProps, 'children'> & {
  children: string;
  suffix?: ReactNode;
};

const ENGLISH_WORD = /^[A-Za-z]+(?:['\u2019-][A-Za-z]+)*$/;
const ENGLISH_WORD_CAPTURE = /([A-Za-z]+(?:['\u2019-][A-Za-z]+)*)/g;
const DOUBLE_TAP_WINDOW_MS = 350;

type PendingWordTap = {
  wordKey: string;
  tappedAt: number;
};

/**
 * Keeps React Native's selectable Copy behavior while making each English word
 * an invisible double-tap target for the system iOS dictionary.
 */
export function NativeLookupText({ children, suffix, ...textProps }: NativeLookupTextProps) {
  const pendingTapRef = useRef<PendingWordTap | null>(null);
  const fragments = useMemo(
    () => children.split(ENGLISH_WORD_CAPTURE),
    [children],
  );

  const handleWordPress = useCallback((wordKey: string, term: string) => {
    const tappedAt = Date.now();
    const pendingTap = pendingTapRef.current;

    if (
      pendingTap?.wordKey === wordKey &&
      tappedAt - pendingTap.tappedAt <= DOUBLE_TAP_WINDOW_MS
    ) {
      pendingTapRef.current = null;
      void openNativeWordLookup(term);
      return;
    }

    pendingTapRef.current = { wordKey, tappedAt };
  }, []);

  const handleWordLongPress = useCallback(() => {
    pendingTapRef.current = null;
  }, []);

  return (
    <Text selectable {...textProps}>
      {fragments.map((fragment, index) => {
        const wordKey = `${index}-${fragment}`;
        return ENGLISH_WORD.test(fragment) ? (
          <Text
            key={wordKey}
            suppressHighlighting
            onPress={() => handleWordPress(wordKey, fragment)}
            onLongPress={handleWordLongPress}
          >
            {fragment}
          </Text>
        ) : (
          fragment
        );
      })}
      {suffix}
    </Text>
  );
}
