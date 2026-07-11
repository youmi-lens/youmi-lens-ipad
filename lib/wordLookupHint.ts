/**
 * One-time discoverability hint for the double-tap word lookup.
 *
 * Shows a subtle hint (rendered by the recording screen) the first time English
 * captions are visible on a device where native lookup works, then remembers it
 * so it never nags again. It auto-dismisses after a few seconds, and dismisses
 * immediately the moment the user actually performs a lookup.
 *
 * "Seen" is persisted per device in AsyncStorage. If native lookup is
 * unavailable the hint is never shown and never marked seen, so it can still
 * appear later on a device/build where lookup works.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';

import { addWordLookupSuccessListener, isNativeWordLookupAvailable } from './nativeWordLookup';
import { shouldShowWordLookupHint } from './wordLookupHintState.mjs';

const STORAGE_KEY = 'youmi.wordLookupHintSeen';
const AUTO_DISMISS_MS = 7000;

/**
 * @param captionsVisible whether English captions are currently on screen.
 * @returns whether the hint should be rendered right now.
 */
export function useWordLookupHint(captionsVisible: boolean): boolean {
  // Assume "seen" until storage says otherwise, so the hint never flashes for
  // users who have already dismissed it.
  const [seen, setSeen] = useState(true);
  const persistedRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((value) => {
        if (mounted) setSeen(value === 'true');
      })
      .catch(() => {
        if (mounted) setSeen(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const markSeen = useCallback(() => {
    if (persistedRef.current) return;
    persistedRef.current = true;
    setSeen(true);
    AsyncStorage.setItem(STORAGE_KEY, 'true').catch(() => {});
  }, []);

  const lookupAvailable = isNativeWordLookupAvailable();
  const visible = shouldShowWordLookupHint({ seen, lookupAvailable, captionsVisible });

  // Auto-dismiss after a short window so it stays non-intrusive.
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(markSeen, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [visible, markSeen]);

  // Dismiss as soon as the user successfully looks a word up.
  useEffect(() => {
    if (!visible) return;
    return addWordLookupSuccessListener(() => markSeen());
  }, [visible, markSeen]);

  return visible;
}
