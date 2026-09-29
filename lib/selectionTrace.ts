/**
 * DEV-only transition log for the selection state machine (both workspaces). One JSON line
 * per state TRANSITION (never per Pencil/finger sample) with the event, the resulting state
 * and — crucially — the clear reason, so "why did my selection disappear?" is answered by a
 * fact from the device instead of a guess. Buffered in memory, flushed on a 1.5 s debounce to
 * `Library/Caches/selection-trace-<workspace>.jsonl`. No-op outside the Dev bundle.
 */
import Constants from 'expo-constants';

import type { SelectionEvent, SelectionResult } from '@/lib/selectionMachine';

const DEV_BUNDLE_ID = 'com.aydenz.youmilensipad.dev';
const MAX_ENTRIES = 400;
export const SELECTION_TRACE_ENABLED = Constants.expoConfig?.ios?.bundleIdentifier === DEV_BUNDLE_ID;

const buffers: Record<string, string[]> = {};
const timers: Record<string, ReturnType<typeof setTimeout> | null> = {};

function flushSoon(workspace: string) {
  if (timers[workspace]) clearTimeout(timers[workspace]!);
  timers[workspace] = setTimeout(() => {
    timers[workspace] = null;
    try {
      const FileSystemNS = require('expo-file-system') as typeof import('expo-file-system');
      const file = new FileSystemNS.File(FileSystemNS.Paths.cache, `selection-trace-${workspace}.jsonl`);
      if (!file.exists) file.create({ intermediates: true, overwrite: true });
      file.write((buffers[workspace] ?? []).join('\n') + '\n');
    } catch {
      // Diagnostics must never affect the app.
    }
  }, 1500);
}

export function traceSelection(workspace: 'notebook' | 'course-material', event: SelectionEvent, result: SelectionResult, before: string, source?: string) {
  if (!SELECTION_TRACE_ENABLED) return;
  const list = (buffers[workspace] ??= []);
  list.push(JSON.stringify({
    at: new Date().toISOString(),
    event: event.type,
    cause: event.type === 'NOOP' ? event.cause : undefined,
    from: before,
    to: result.state.kind,
    cleared: result.cleared,
    source,
  }));
  if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
  flushSoon(workspace);
}
