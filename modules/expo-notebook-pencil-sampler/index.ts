/**
 * Native Apple Pencil sample source for Notebook's Natural Pen input
 * foundation (iOS development/standalone builds only — absent from Expo Go).
 *
 * App code should NOT import this file directly. Use
 * `lib/notebookPencilSampler.ts`, which resolves the native view safely so
 * Notebook keeps working — on the existing RNGH-only path, unchanged — when
 * the native module is not present.
 */
import { requireNativeViewManager } from 'expo-modules-core';
import type React from 'react';

/** One authoritative sample: every field read from the same native UITouch. */
export type NotebookPencilSampleEvent = {
  phase: 'began' | 'moved' | 'ended' | 'cancelled';
  x: number;
  y: number;
  /** Normalized 0...1, or null when the device/touch cannot report pressure. Never fabricated. */
  p: number | null;
  /** `UITouch.timestamp` passthrough (seconds since system boot). */
  t: number;
};

export type ExpoNotebookPencilSamplerViewProps = {
  style?: unknown;
  onPencilSample?: (event: { nativeEvent: NotebookPencilSampleEvent }) => void;
};

let ExpoNotebookPencilSamplerView: React.ComponentType<ExpoNotebookPencilSamplerViewProps> | null;
try {
  ExpoNotebookPencilSamplerView = requireNativeViewManager<ExpoNotebookPencilSamplerViewProps>(
    'ExpoNotebookPencilSampler',
  );
} catch {
  ExpoNotebookPencilSamplerView = null;
}

export { ExpoNotebookPencilSamplerView };
