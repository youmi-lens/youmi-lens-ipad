import AsyncStorage from '@react-native-async-storage/async-storage';

import { scopedTutorialCompletionKey } from './tutorialCore.mjs';

/**
 * Whether the tutorial has already been shown-and-dismissed (via Finish or
 * Skip — both count) for this user/guest scope. Local device storage only;
 * no Supabase write path exists for tutorial completion.
 */
export async function loadTutorialCompleted(scopeId: string): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(scopedTutorialCompletionKey(scopeId));
    return raw === 'true';
  } catch {
    return false;
  }
}

export async function saveTutorialCompleted(scopeId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(scopedTutorialCompletionKey(scopeId), 'true');
  } catch {
    // Best-effort: a failed write just means the tutorial may auto-show
    // again next launch, which is a harmless, recoverable outcome.
  }
}
