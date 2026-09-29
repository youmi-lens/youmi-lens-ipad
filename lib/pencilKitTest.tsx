/**
 * PK1 — isolated Apple PencilKit physical spike.
 *
 * `PencilKitTestSurface` renders a real, disposable `PKCanvasView` — Apple's
 * own native ink rendering, entirely independent of Youmi's custom Natural
 * Pen renderer (`lib/notebookStroke.ts`) and native Pencil sampler
 * (`lib/notebookPencilSampler.ts`, `modules/expo-notebook-pencil-sampler`).
 * Neither of those is imported or referenced here.
 *
 * PK1's own isolated screen never persists: drawing lives only in the native
 * view's memory, and unmounting (closing the test screen) discards
 * everything — it never calls `save`/`load` below. PK3-B added `save`/`load`
 * (a `file://` path in, PKDrawing.dataRepresentation() bytes read/written
 * entirely native-side — never crossing the JS bridge) for the PK3-A
 * embedded-in-real-Notebook use site only; see lib/notebookInkStorage.ts and
 * the PK3-B report for the storage architecture and save-trigger design.
 *
 * Availability follows the same optional-module pattern as
 * `lib/notebookPencilSampler.ts` — when the native module is absent (Expo
 * Go, non-iOS, or a build without it), `PencilKitTestSurface` renders a
 * plain `View` and `isPencilKitTestAvailable()` returns false; callers (the
 * Dev-only entry point) should hide the "DEV · Apple Pen Test" button
 * entirely in that case rather than opening a broken screen.
 */
import { forwardRef, useImperativeHandle, useRef } from 'react';
import type React from 'react';
import { Platform, View, type StyleProp, type ViewStyle } from 'react-native';

import {
  ExpoPencilKitTestView,
  type ExpoPencilKitTestNativeRef,
  type PencilKitWidthPreset,
  type PencilKitLoadResult,
  type PencilKitSaveResult,
  type PencilStrokeActiveChangeEvent,
} from '@/modules/expo-pencilkit-test';

export type { PencilKitWidthPreset };

export function isPencilKitTestAvailable(): boolean {
  return Platform.OS === 'ios' && ExpoPencilKitTestView != null;
}

export type PencilKitTestSurfaceRef = {
  /** Resets the native canvas to an empty PKDrawing(). Never touches Notebook data. */
  clear: () => Promise<void>;
  /** PK2 width verification only (section 19) — changes the base width of the
   * NEXT stroke; does not affect already-drawn ink. */
  setWidthPreset: (preset: PencilKitWidthPreset) => Promise<void>;
  /** PK3-B — durably writes the current drawing to `path` (a `file://` URI).
   * Resolves to `{success: false, ...}` (never rejects) when the native
   * module is unavailable, matching every other method here. */
  save: (path: string) => Promise<PencilKitSaveResult>;
  /** PK3-B — loads `path` into the canvas if valid; a no-op (success: false)
   * for a note that has never had PencilKit ink, never an error. */
  load: (path: string) => Promise<PencilKitLoadResult>;
};

export type PencilKitTestSurfaceProps = {
  style?: unknown;
  /** PK3-A only — see modules/expo-pencilkit-test's ExpoPencilKitTestViewProps. */
  transparent?: boolean;
  /** PK3-A gesture-ownership fix only — see ExpoPencilKitTestViewProps. */
  onPencilStrokeActiveChange?: (event: { nativeEvent: PencilStrokeActiveChangeEvent }) => void;
};

/** Plain fallback when the native module is unavailable — same shape, no-op clear(). */
const Fallback = forwardRef<PencilKitTestSurfaceRef, PencilKitTestSurfaceProps>(function PencilKitTestFallback(
  { style },
  ref,
) {
  useImperativeHandle(
    ref,
    () => ({
      clear: async () => {},
      setWidthPreset: async () => {},
      save: async () => ({ success: false, strokeCount: 0, byteSize: 0 }),
      load: async () => ({ success: false, strokeCount: 0, usedBackup: false }),
    }),
    [],
  );
  return <View style={style as StyleProp<ViewStyle>} />;
});

const NativeSurface = forwardRef<PencilKitTestSurfaceRef, PencilKitTestSurfaceProps>(function PencilKitTestNative(
  { style, transparent, onPencilStrokeActiveChange },
  ref,
) {
  const nativeRef = useRef<ExpoPencilKitTestNativeRef>(null);
  useImperativeHandle(
    ref,
    () => ({
      clear: async () => {
        await nativeRef.current?.clearAsync?.();
      },
      setWidthPreset: async (preset) => {
        await nativeRef.current?.setWidthPresetAsync?.(preset);
      },
      save: async (path) => {
        const result = await nativeRef.current?.saveDrawingAsync?.(path);
        return result ?? { success: false, strokeCount: 0, byteSize: 0 };
      },
      load: async (path) => {
        const result = await nativeRef.current?.loadDrawingAsync?.(path);
        return result ?? { success: false, strokeCount: 0, usedBackup: false };
      },
    }),
    [],
  );
  const NativeComponent = ExpoPencilKitTestView as React.ComponentType<
    {
      style?: unknown;
      transparent?: boolean;
      onPencilStrokeActiveChange?: (event: { nativeEvent: PencilStrokeActiveChangeEvent }) => void;
    } & { ref?: React.Ref<ExpoPencilKitTestNativeRef | null> }
  >;
  return (
    <NativeComponent
      ref={nativeRef}
      style={style}
      transparent={transparent}
      onPencilStrokeActiveChange={onPencilStrokeActiveChange}
    />
  );
});

export const PencilKitTestSurface = isPencilKitTestAvailable() ? NativeSurface : Fallback;
