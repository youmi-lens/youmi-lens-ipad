/**
 * Optional native Apple Pencil sampler for Notebook (Natural Pen input
 * foundation — see `modules/expo-notebook-pencil-sampler`).
 *
 * `ExpoNotebookPencilSamplerView` is a thin overlay that reports one
 * authoritative `{x, y, p, t}` sample per native touch event, all four
 * fields read from the same `UITouch` — richer than what
 * `react-native-gesture-handler`'s `onTouchesMove` alone can provide (no
 * pressure, no coalesced samples; see the Phase 3B-1 investigation).
 *
 * When the native module is absent (Expo Go, non-iOS, or any build without
 * it), `NotebookPencilSamplerOverlay` is a plain passthrough `View` — it still
 * renders its children in the same place with the same layout, it just never
 * calls `onPencilSample`. Notebook's Pen tool keeps working exactly as it did
 * before this module existed — plain RNGH points, no pressure. Callers (i.e.
 * `NotebookCanvas.tsx`) never need to branch on availability.
 */
import type React from 'react';
import { Platform, View } from 'react-native';

import { ExpoNotebookPencilSamplerView, type NotebookPencilSampleEvent } from '@/modules/expo-notebook-pencil-sampler';

export type { NotebookPencilSampleEvent };

type NotebookPencilSamplerOverlayProps = {
  style?: unknown;
  onPencilSample?: (event: { nativeEvent: NotebookPencilSampleEvent }) => void;
  children?: React.ReactNode;
};

/** Whether the native Pencil sampler is available in this build. */
export function isNotebookPencilSamplerAvailable(): boolean {
  return Platform.OS === 'ios' && ExpoNotebookPencilSamplerView != null;
}

export const NotebookPencilSamplerOverlay: React.ComponentType<NotebookPencilSamplerOverlayProps> =
  ExpoNotebookPencilSamplerView ?? (View as unknown as React.ComponentType<NotebookPencilSamplerOverlayProps>);
