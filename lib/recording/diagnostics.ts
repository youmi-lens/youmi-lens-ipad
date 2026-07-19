/**
 * Recording outcome diagnostics — privacy-minimal, console only.
 *
 * These events exist to answer "did native recording behave" during internal
 * dogfooding. They are written to the JS console like Live Caption
 * diagnostics; no analytics SDK and no network call is involved.
 *
 * The allowlist below is the privacy boundary. Anything not named here is
 * dropped by `sanitizeRecordingDiagnostics`, so audio, transcript, caption or
 * translation text, titles, emails, raw IDs and file paths cannot be emitted
 * even by a careless call site.
 */
import { RECORDING_FALLBACK_REASONS } from './policy.mjs';

export type RecordingDiagnosticEvent =
  | 'recorder_engine_selected'
  | 'native_initialization_succeeded'
  | 'native_initialization_failed'
  | 'recorder_fallback_to_legacy'
  | 'native_recording_started'
  | 'native_recording_paused'
  | 'native_recording_resumed'
  | 'native_recording_finalized'
  | 'native_recovery_offered'
  | 'native_recovery_resumed'
  | 'native_recovery_discarded'
  | 'native_handoff_completed'
  | 'native_handoff_retried'
  | 'native_reconciliation_issue';

/**
 * The only fields that may ever be emitted. Deliberately excludes every
 * identifier: no user id, lecture id, session id, segment id or path.
 */
const ALLOWED_FIELDS = Object.freeze([
  'engine',
  'source',
  'reason',
  'issueCode',
  'appBuild',
  'sessionState',
  'segmentCount',
  'durationBucket',
  'recovered',
  'handoffCompleted',
  'hasRecoverableSession',
  'recoverableSessionCount',
  'hasReconciliationIssues',
  'cohort',
]);

const ALLOWED_FIELD_SET = new Set<string>(ALLOWED_FIELDS);

/** Coarse duration buckets — precise durations are unnecessary for outcomes. */
export function durationBucket(durationMillis: number | null | undefined): string {
  if (typeof durationMillis !== 'number' || !Number.isFinite(durationMillis) || durationMillis < 0) {
    return 'unknown';
  }
  const seconds = durationMillis / 1000;
  if (seconds < 10) return '<10s';
  if (seconds < 60) return '10-60s';
  if (seconds < 300) return '1-5m';
  if (seconds < 1800) return '5-30m';
  if (seconds < 5400) return '30-90m';
  return '>90m';
}

function isEmittableValue(value: unknown): boolean {
  return (
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    (typeof value === 'string' && value.length <= 64)
  );
}

/**
 * Drops every field outside the allowlist and every value that is not a small
 * scalar. Exported so tests can prove forbidden content cannot escape.
 */
export function sanitizeRecordingDiagnostics(
  detail: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  if (!detail) return safe;
  for (const key of Object.keys(detail).sort()) {
    if (!ALLOWED_FIELD_SET.has(key)) continue;
    const value = detail[key];
    if (value === null || value === undefined) continue;
    if (!isEmittableValue(value)) continue;
    safe[key] = value as string | number | boolean;
  }
  return safe;
}

export function isRecordingFallbackReason(value: unknown): boolean {
  return typeof value === 'string' && (RECORDING_FALLBACK_REASONS as readonly string[]).includes(value);
}

/** Log a recording outcome event. Sanitized, deterministic, console only. */
export function logRecordingEvent(
  event: RecordingDiagnosticEvent,
  detail?: Record<string, unknown>,
): void {
  const safe = sanitizeRecordingDiagnostics(detail);
  const payload = JSON.stringify(safe);
  if (Object.keys(safe).length === 0) console.log(`[recorder] ${event}`);
  else console.log(`[recorder] ${event}`, payload);
}

/** Developer-readable summary of recording state. Contains no identifiers. */
export type RecordingDiagnosticSummary = {
  engine: string;
  source: string;
  fallbackReason: string | null;
  nativeCapabilityAvailable: boolean;
  recoverableSessionCount: number;
  hasReconciliationIssues: boolean;
  lastOutcome: string | null;
  defaultsToLegacy: boolean;
};

export function formatRecordingDiagnosticSummary(summary: RecordingDiagnosticSummary): string {
  return [
    `engine=${summary.engine}`,
    `source=${summary.source}`,
    `fallback=${summary.fallbackReason ?? 'none'}`,
    `nativeAvailable=${summary.nativeCapabilityAvailable}`,
    `recoverable=${summary.recoverableSessionCount}`,
    `issues=${summary.hasReconciliationIssues}`,
    `lastOutcome=${summary.lastOutcome ?? 'none'}`,
    `defaultsToLegacy=${summary.defaultsToLegacy}`,
  ].join(' ');
}
