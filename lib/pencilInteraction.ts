/**
 * Optional Apple Pencil double-tap support.
 *
 * Apple Pencil double-tap is delivered by `UIPencilInteraction`, a native iOS
 * API with no React Native or Expo Go equivalent. This wrapper lazily looks up
 * an optional native module (`ExpoPencilInteraction`) that is only compiled
 * into a development or standalone build — see `modules/expo-pencil-interaction`.
 *
 * When the module is absent — Expo Go, web, Android, or any build without the
 * native module — every export here degrades to a safe no-op, so the app keeps
 * running normally and the toolbar remains the way to switch tools.
 *
 * `expo-modules-core` is a guaranteed dependency of every Expo app and never
 * crashes on import; `requireOptionalNativeModule` returns `null` (rather than
 * throwing) when the native module cannot be found.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

type EventSubscription = { remove: () => void };

/** Minimal shape of the optional native module (see PencilInteractionModule.swift). */
type PencilInteractionModule = {
  isAvailable?: () => boolean;
  addListener: (eventName: string, listener: () => void) => EventSubscription;
};

const PENCIL_DOUBLE_TAP_EVENT = 'onPencilDoubleTap';

let lookedUp = false;
let nativeModule: PencilInteractionModule | null = null;

/** Resolve the optional native module once, caching the result. */
function getNativeModule(): PencilInteractionModule | null {
  if (lookedUp) return nativeModule;
  lookedUp = true;

  // UIPencilInteraction is iOS-only; skip the lookup everywhere else.
  if (Platform.OS !== 'ios') {
    nativeModule = null;
    return null;
  }

  try {
    nativeModule = requireOptionalNativeModule<PencilInteractionModule>('ExpoPencilInteraction');
  } catch {
    // Defensive: requireOptionalNativeModule is not expected to throw.
    nativeModule = null;
  }
  return nativeModule;
}

/**
 * Whether native Apple Pencil double-tap detection is available.
 *
 * Returns `false` in Expo Go, on web and on Android. Returns `true` only in an
 * iOS development/standalone build that includes the native module.
 */
export function isPencilDoubleTapAvailable(): boolean {
  const mod = getNativeModule();
  if (!mod) return false;
  try {
    return typeof mod.isAvailable === 'function' ? mod.isAvailable() : true;
  } catch {
    return false;
  }
}

/**
 * Subscribe to Apple Pencil double-tap events.
 *
 * The returned function removes the listener. When native double-tap is
 * unavailable this is a no-op subscription — the callback simply never fires,
 * and callers do not need to branch on availability.
 */
export function addPencilDoubleTapListener(callback: () => void): () => void {
  const mod = getNativeModule();
  if (!mod) return () => {};

  try {
    const subscription = mod.addListener(PENCIL_DOUBLE_TAP_EVENT, callback);
    return () => {
      try {
        subscription.remove();
      } catch {
        // Listener already removed / module torn down — nothing to do.
      }
    };
  } catch {
    return () => {};
  }
}
