import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

type NativeWordLookupModule = {
  isAvailable?: () => boolean;
  openAsync: (term: string) => Promise<boolean>;
};

let lookedUp = false;
let nativeModule: NativeWordLookupModule | null = null;

type WordLookupSuccessListener = (term: string) => void;
const successListeners = new Set<WordLookupSuccessListener>();

/**
 * Subscribe to successful dictionary lookups (used only for UX signals such as
 * dismissing the discoverability hint). Purely additive — it does not change
 * the double-tap trigger behavior. Returns an unsubscribe function.
 */
export function addWordLookupSuccessListener(listener: WordLookupSuccessListener): () => void {
  successListeners.add(listener);
  return () => {
    successListeners.delete(listener);
  };
}

function getNativeModule(): NativeWordLookupModule | null {
  if (lookedUp) return nativeModule;
  lookedUp = true;

  if (Platform.OS !== 'ios') return null;

  try {
    nativeModule = requireOptionalNativeModule<NativeWordLookupModule>('ExpoNativeWordLookup');
  } catch {
    nativeModule = null;
  }
  return nativeModule;
}

export function isNativeWordLookupAvailable(): boolean {
  const module = getNativeModule();
  if (!module) return false;

  try {
    return typeof module.isAvailable === 'function' ? module.isAvailable() : true;
  } catch {
    return false;
  }
}

export async function openNativeWordLookup(term: string): Promise<boolean> {
  const normalizedTerm = term.trim();
  if (!normalizedTerm) return false;

  const module = getNativeModule();
  if (!module) return false;

  try {
    const opened = await module.openAsync(normalizedTerm);
    if (opened) {
      successListeners.forEach((listener) => listener(normalizedTerm));
    }
    return opened;
  } catch {
    return false;
  }
}
