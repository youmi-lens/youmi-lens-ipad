/**
 * What the owner is told when Finish fails.
 *
 * ONE known condition is truthfully "your recording is safe, just retry": the native exporter's own background-time
 * expiry (DurableFinalAssetExporter.backgroundTimeExpiredMessage). It is recognized by BOTH the stable native error
 * code and the exact phrase, so no other failure can ever borrow the reassurance. Every other failure keeps the generic,
 * non-reassuring message — we do not claim data is safe for failures we have not classified.
 */
export const FINISH_FAILURE_GENERIC_MESSAGE = 'Could not finish the recording.';

export const FINISH_BACKGROUND_EXPIRED_MESSAGE =
  'Your recording is safe. Keep Youmi Lens open and tap Finish again to finish saving.';

const FINAL_ASSET_EXPORT_CODE = 'ERR_DURABLE_RECORDER_FINAL_ASSET_EXPORT';
const BACKGROUND_EXPIRED_MARKER = 'ran out of background time';

/** @param {{ errorCode?: string | null, error?: string | null } | null | undefined} failure */
export function isBackgroundExpiredFinishFailure(failure) {
  return (
    failure?.errorCode === FINAL_ASSET_EXPORT_CODE
    && typeof failure.error === 'string'
    && failure.error.includes(BACKGROUND_EXPIRED_MARKER)
  );
}

/** @param {{ errorCode?: string | null, error?: string | null } | null | undefined} failure */
export function finishFailureUserMessage(failure) {
  return isBackgroundExpiredFinishFailure(failure)
    ? FINISH_BACKGROUND_EXPIRED_MESSAGE
    : FINISH_FAILURE_GENERIC_MESSAGE;
}
