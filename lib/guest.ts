/**
 * Guest Mode — local-only access without a Youmi Lens account.
 *
 * A guest can enter the app and record a small number of short lectures that
 * stay on this device only. Guests have no Supabase user_id, so they never
 * touch account quota, cloud upload, backend AI processing, or cross-device
 * sync. All guest state lives in plain (un-scoped) AsyncStorage on the device.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

/** Persisted flag: the user chose to continue without an account. */
export const GUEST_MODE_KEY = 'youmi_guest_mode';
/**
 * Storage scope id used for a guest's local-only courses/lectures. The data
 * store keys its on-device cache by this id (instead of a Supabase user id) so
 * guest recordings survive an app restart without ever touching the cloud.
 */
export const GUEST_STORAGE_SCOPE = '__guest__';
/** Persisted count of guest recordings captured on this device/app install. */
export const GUEST_RECORDINGS_USED_KEY = 'youmi_guest_recordings_used';
/** How many guest recordings are allowed per local device/app install. */
export const GUEST_RECORDING_LIMIT = 2;
/** Maximum duration of a single guest recording, in seconds. */
export const GUEST_MAX_RECORDING_SECONDS = 120;

/** Read how many guest recordings have been used on this device. */
export async function getGuestRecordingsUsed(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(GUEST_RECORDINGS_USED_KEY);
    const parsed = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

/** Increment and persist the guest recording count; returns the new total. */
export async function incrementGuestRecordingsUsed(): Promise<number> {
  const next = (await getGuestRecordingsUsed()) + 1;
  try {
    await AsyncStorage.setItem(GUEST_RECORDINGS_USED_KEY, String(next));
  } catch {
    // Best effort — if persistence fails the in-session count still reflects use.
  }
  return next;
}

/** Guest recordings still available given a used count. */
export function guestRecordingsRemaining(used: number): number {
  return Math.max(0, GUEST_RECORDING_LIMIT - used);
}

/**
 * Screen hook: tracks how many guest recordings remain. Refreshes whenever the
 * screen regains focus so the Record tab reflects a recording finished elsewhere.
 */
export function useGuestRecordingUsage() {
  const [used, setUsed] = useState(0);

  const refresh = useCallback(async () => {
    setUsed(await getGuestRecordingsUsed());
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  return { used, remaining: guestRecordingsRemaining(used), refresh };
}
