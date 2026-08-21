export const TRANSCRIPT_CHUNK_TARGET_CHARS = 1200;
const TRANSCRIPT_READ_CACHE_LIMIT = 4;
const transcriptReadCache = new Map();

/** Split without changing a single character; joining the chunks is lossless. */
export function chunkTranscript(text, targetChars = TRANSCRIPT_CHUNK_TARGET_CHARS) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const target = Number.isFinite(targetChars) ? Math.max(200, Math.floor(targetChars)) : TRANSCRIPT_CHUNK_TARGET_CHARS;
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + target);
    if (end < text.length) {
      const paragraphBreak = text.lastIndexOf('\n\n', end);
      const sentenceBreak = Math.max(text.lastIndexOf('. ', end), text.lastIndexOf('。', end));
      const whitespace = text.lastIndexOf(' ', end);
      const candidate = Math.max(paragraphBreak >= start + 200 ? paragraphBreak + 2 : -1,
        sentenceBreak >= start + 200 ? sentenceBreak + (text[sentenceBreak] === '。' ? 1 : 2) : -1,
        whitespace >= start + 200 ? whitespace + 1 : -1);
      if (candidate > start) end = candidate;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

export function buildTranscriptReadItems(sections, targetChars = TRANSCRIPT_CHUNK_TARGET_CHARS) {
  return sections.flatMap((section) => {
    const header = { key: `${section.side}:header`, type: 'header', ...section };
    const chunks = chunkTranscript(section.text, targetChars).map((text, index) => ({
      key: `${section.side}:chunk:${index}`,
      type: 'chunk',
      side: section.side,
      language: section.language,
      text,
    }));
    return [header, ...(chunks.length > 0 ? chunks : [{ key: `${section.side}:empty`, type: 'empty', side: section.side }])];
  });
}

/** Return prepared rows through the caller's stable document-version identity. */
export function getCachedTranscriptReadItems(cacheKey, targetChars = TRANSCRIPT_CHUNK_TARGET_CHARS) {
  const cached = transcriptReadCache.get(cacheKey);
  if (!cached || cached.targetChars !== targetChars) return undefined;
  transcriptReadCache.delete(cacheKey);
  transcriptReadCache.set(cacheKey, cached);
  return cached.items;
}

/** Build once, then retain only a few recent lecture documents in memory. */
export function prepareTranscriptReadItems(cacheKey, sections, targetChars = TRANSCRIPT_CHUNK_TARGET_CHARS) {
  const cached = getCachedTranscriptReadItems(cacheKey, targetChars);
  if (cached) return cached;

  const items = buildTranscriptReadItems(sections, targetChars);
  transcriptReadCache.set(cacheKey, {
    targetChars,
    items,
  });
  while (transcriptReadCache.size > TRANSCRIPT_READ_CACHE_LIMIT) {
    transcriptReadCache.delete(transcriptReadCache.keys().next().value);
  }
  return items;
}

/** Test-only reset for deterministic cache assertions. */
export function clearTranscriptReadItemsCache() {
  transcriptReadCache.clear();
}
