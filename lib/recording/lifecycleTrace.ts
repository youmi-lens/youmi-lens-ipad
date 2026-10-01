/**
 * DEV-ONLY (Dev bundle) monotonic JS-side lifecycle timeline for the "recording pauses after backgrounding" investigation:
 * AppState transitions, UI pause/resume requests, native status arrivals and session-state applications. Content-free
 * (states and reasons only), bounded, flushed when idle. Inert in every other bundle. Never throws.
 */
import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';

export const RECORDING_LIFECYCLE_TRACE_ENABLED =
  Constants.expoConfig?.ios?.bundleIdentifier === 'com.aydenz.youmilensipad.dev';

type Detail = Record<string, string | number | boolean | null | undefined>;
const MAX_ENTRIES = 1500;
const entries: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  timer = null;
  try {
    const file = new File(Paths.cache, 'recording-lifecycle-js.jsonl');
    if (!file.exists) file.create({ intermediates: true, overwrite: true });
    file.write(entries.join('\n') + '\n');
  } catch {
    // never affect recording
  }
}

export function traceRecordingLifecycle(event: string, details?: Detail): void {
  if (!RECORDING_LIFECYCLE_TRACE_ENABLED) return;
  try {
    entries.push(JSON.stringify({ atMs: Date.now(), event, ...details }));
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 3000);
  } catch {
    // ignore
  }
}
