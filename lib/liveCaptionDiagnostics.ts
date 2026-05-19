/**
 * Live Caption diagnostics — structured failure reasons + internal logging.
 *
 * These reasons are for engineers reading device logs; they are NEVER shown
 * verbatim in the UI. The user only ever sees a calm, plain message.
 */

export type LiveCaptionUnavailableReason =
  | 'no_pcm_callbacks'
  | 'websocket_closed'
  | 'websocket_error'
  | 'backend_stream_error'
  | 'deepgram_upstream_drop'
  | 'stream_start_timeout'
  | 'stream_ready_timeout'
  | 'mic_permission_denied'
  | 'token_missing'
  | 'token_expired'
  | 'audio_session_conflict'
  | 'unknown';

/** Lightweight, secret-free snapshot logged when Live Caption degrades. */
export type LiveCaptionDiagnosticSnapshot = {
  timestamp: string;
  wsState: string;
  lastWsEvent: string | null;
  lastCloseCode: number | null;
  lastCloseReason: string | null;
  backendReady: boolean;
  streamReadyReceived: boolean;
  tokenPresent: boolean;
  micStarted: boolean;
  micFramesReceived: number;
  pcmFramesSent: number;
  lastPcmAt: string | null;
  localRecordingActive: boolean | null;
  retryAttempted: boolean;
  reconnectAttempts: number;
  screen: string;
};

/**
 * Log a Live Caption failure with its structured reason + snapshot. Goes to the
 * JS console only — contains no secrets and is never surfaced in the UI.
 */
export function logLiveCaptionUnavailable(
  reason: LiveCaptionUnavailableReason,
  snapshot: Partial<LiveCaptionDiagnosticSnapshot>,
): void {
  console.warn(
    `[liveCaption] unavailable_reason=${reason}`,
    JSON.stringify({ timestamp: new Date().toISOString(), ...snapshot }),
  );
}

/** Log a Live Caption lifecycle/recovery milestone (reconnect, stream_ready, …). */
export function logLiveCaptionEvent(event: string, detail?: Record<string, unknown>): void {
  if (detail) console.log(`[liveCaption] ${event}`, JSON.stringify(detail));
  else console.log(`[liveCaption] ${event}`);
}
