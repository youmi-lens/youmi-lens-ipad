/**
 * Pure helpers for recording persistence / resumable lecture sessions.
 *
 * A lecture used to be created only at Finish, so pausing, tapping Back, or
 * backgrounding the app silently discarded everything captured so far. These
 * pure helpers decide when a session is worth keeping and how to merge an
 * earlier session's captions with newly recorded ones, so the wiring in
 * app/recording.tsx stays small and this logic is directly unit-testable.
 */

/**
 * Whether a recording session has enough content that discarding it would lose
 * real user work. Matches the product spec's "meaningful content" list:
 * transcript, translation, non-zero duration, saved audio, or marks.
 *
 * @param {{
 *   durationMillis?: number,
 *   hasAudio?: boolean,
 *   captionCount?: number,
 *   markCount?: number,
 *   transcriptLength?: number,
 * }} input
 * @returns {boolean}
 */
export function hasMeaningfulRecordingContent(input = {}) {
  const durationMillis = Number.isFinite(input.durationMillis) ? input.durationMillis : 0;
  const captionCount = Number.isFinite(input.captionCount) ? input.captionCount : 0;
  const markCount = Number.isFinite(input.markCount) ? input.markCount : 0;
  const transcriptLength = Number.isFinite(input.transcriptLength) ? input.transcriptLength : 0;
  return (
    Boolean(input.hasAudio) ||
    durationMillis > 0 ||
    captionCount > 0 ||
    markCount > 0 ||
    transcriptLength > 0
  );
}

/**
 * Merge a previously-persisted caption history with the current session's lines,
 * de-duplicating by id (a resumed session re-seeds the earlier lines, and a
 * translation that arrives later should update — not duplicate — its line).
 * Order is preserved: existing lines first, then any genuinely new ones.
 *
 * @template {{ id: string, text?: string, translationZh?: string }} T
 * @param {T[]} existing
 * @param {T[]} incoming
 * @returns {T[]}
 */
export function mergeCaptionLines(existing, incoming) {
  const base = Array.isArray(existing) ? existing : [];
  const next = Array.isArray(incoming) ? incoming : [];
  const byId = new Map();
  const order = [];
  for (const line of [...base, ...next]) {
    if (!line || typeof line.id !== 'string') continue;
    if (!byId.has(line.id)) order.push(line.id);
    // Later occurrences win so a line gains its translation / corrected text.
    const prev = byId.get(line.id) || {};
    byId.set(line.id, { ...prev, ...line });
  }
  return order.map((id) => byId.get(id));
}

/** Join caption lines into English + Chinese draft transcripts. Pure. */
export function captionsToTranscript(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  const en = arr
    .map((l) => (l && typeof l.text === 'string' ? l.text.trim() : ''))
    .filter(Boolean)
    .join('\n');
  const zh = arr
    .map((l) => (l && typeof l.translationZh === 'string' ? l.translationZh.trim() : ''))
    .filter(Boolean)
    .join('\n');
  return { en, zh };
}
