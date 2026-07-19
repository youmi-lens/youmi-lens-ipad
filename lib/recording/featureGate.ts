export type RecordingEngine = 'legacy' | 'nativeDurable';

// Phase 2C rollout boundary. Keep this committed value on legacy. Controlled
// device verification may change this line locally, then must restore it.
export const CONFIGURED_RECORDING_ENGINE: RecordingEngine = 'legacy';

export function resolveRecordingEngine(forceLegacy = false): RecordingEngine {
  return forceLegacy ? 'legacy' : CONFIGURED_RECORDING_ENGINE;
}
