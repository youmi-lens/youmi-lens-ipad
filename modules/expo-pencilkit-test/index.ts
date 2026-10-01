/**
 * PK1 — isolated Apple PencilKit physical spike (iOS development/standalone
 * builds only — absent from Expo Go). Dev-only, disposable, no persistence.
 *
 * App code should NOT import this file directly. Use
 * `lib/pencilKitTest.ts`, which resolves the native view safely so the app
 * keeps working when the native module is not present.
 */
import { requireNativeViewManager } from 'expo-modules-core';
import type React from 'react';

export type PencilStrokeActiveChangeEvent = { active: boolean };

export type ExpoPencilKitTestViewProps = {
  style?: unknown;
  /** PK3-A only — transparent so content beneath this overlay stays visible
   * (used when embedded inside the real Notebook canvas). Defaults to false
   * (opaque white), preserving the PK1/PK2 isolated screen unchanged. */
  transparent?: boolean;
  /** PK3-A gesture-ownership fix — fires exactly twice per stroke (begin,
   * end), from PKCanvasViewDelegate's real canvasViewDidBeginUsingTool/
   * canvasViewDidEndUsingTool. Never fires per-move. See
   * PencilKitTestModule.swift. */
  onPencilStrokeActiveChange?: (event: { nativeEvent: PencilStrokeActiveChangeEvent }) => void;
};

export type PencilKitWidthPreset = 'thin' | 'medium' | 'thick';

/** PK3-B — see PencilKitTestModule.swift's saveDrawing/loadDrawing. */
export type PencilKitSaveResult = { success: boolean; strokeCount: number; byteSize: number };
export type PencilKitLoadResult = { success: boolean; strokeCount: number; usedBackup: boolean };

export type ExpoPencilKitTestNativeRef = {
  clearAsync?: () => Promise<void>;
  /** PK2 width verification only (section 19) — see PencilKitTestModule.swift. */
  setWidthPresetAsync?: (preset: PencilKitWidthPreset) => Promise<void>;
  /** PK3-B — path is a `file://` URI; bytes never cross the bridge. */
  saveDrawingAsync?: (path: string) => Promise<PencilKitSaveResult>;
  loadDrawingAsync?: (path: string) => Promise<PencilKitLoadResult>;
};

let ExpoPencilKitTestView: React.ComponentType<
  ExpoPencilKitTestViewProps & { ref?: React.Ref<ExpoPencilKitTestNativeRef | null> }
> | null;
try {
  ExpoPencilKitTestView = requireNativeViewManager<ExpoPencilKitTestViewProps>('ExpoPencilKitTest');
} catch {
  ExpoPencilKitTestView = null;
}

export { ExpoPencilKitTestView };
