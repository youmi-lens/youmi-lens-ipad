/**
 * Pure gate for applying native durable-recorder status into the JS adapter.
 * Native is authoritative for forced pause; this only rejects unsafe/stale updates.
 */

/**
 * @param {{
 *   currentSessionId: string | null | undefined,
 *   currentState: string | null | undefined,
 *   finishing: boolean,
 *   lastSequence: number,
 *   status: {
 *     recordingSessionId?: string,
 *     statusSequence?: number,
 *     session?: { recordingSessionId?: string, state?: string } | null,
 *   },
 * }} input
 * @returns {{ accept: boolean, reason: string, nextSequence: number }}
 */
export function evaluateNativeStatusUpdate(input) {
  const currentSessionId = input.currentSessionId ?? null;
  const currentState = input.currentState ?? null;
  const finishing = input.finishing === true;
  const lastSequence = Number.isInteger(input.lastSequence) ? input.lastSequence : 0;
  const status = input.status ?? {};
  const statusSessionId = status.session?.recordingSessionId ?? status.recordingSessionId ?? null;
  const nextSequence =
    typeof status.statusSequence === 'number' && Number.isInteger(status.statusSequence)
      ? status.statusSequence
      : lastSequence;

  if (!currentSessionId) {
    return { accept: false, reason: 'no_current_session', nextSequence: lastSequence };
  }
  if (!statusSessionId || statusSessionId !== currentSessionId) {
    return { accept: false, reason: 'session_mismatch', nextSequence: lastSequence };
  }
  if (
    typeof status.statusSequence === 'number' &&
    Number.isInteger(status.statusSequence) &&
    status.statusSequence <= lastSequence
  ) {
    return { accept: false, reason: 'stale_sequence', nextSequence: lastSequence };
  }
  if (
    finishing ||
    currentState === 'finalized' ||
    currentState === 'finalizing' ||
    currentState === 'abandoned' ||
    currentState === 'failed'
  ) {
    return { accept: false, reason: 'terminal_or_finishing', nextSequence: nextSequence };
  }
  if (!status.session?.state) {
    return { accept: false, reason: 'missing_session', nextSequence: nextSequence };
  }
  if (
    status.session.state !== 'paused' &&
    status.session.state !== 'recording' &&
    status.session.state !== 'finalized'
  ) {
    return { accept: false, reason: 'ignored_state', nextSequence: nextSequence };
  }
  return { accept: true, reason: 'apply', nextSequence };
}
