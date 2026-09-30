const defaultNow = () => globalThis.performance?.now?.() ?? Date.now();

const defaultYieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * JSON.stringify is synchronous. Serializing one page record at a time and
 * yielding between short slices keeps Pencil/tool events moving while
 * preserving the exact persisted JSON array schema.
 */
export async function stringifyJsonArrayCooperatively(
  values,
  {
    sliceMs = 8,
    now = defaultNow,
    yieldToEventLoop = defaultYieldToEventLoop,
  } = {},
) {
  const parts = ['['];
  let sliceStartedAt = now();

  for (let index = 0; index < values.length; index += 1) {
    if (index > 0) parts.push(',');
    const encoded = JSON.stringify(values[index]);
    parts.push(encoded === undefined ? 'null' : encoded);

    if (index + 1 < values.length && now() - sliceStartedAt >= sliceMs) {
      await yieldToEventLoop();
      sliceStartedAt = now();
    }
  }

  parts.push(']');
  return parts.join('');
}

/**
 * Coalesces rapid annotation snapshots per storage key. A newer snapshot that
 * arrives during cooperative serialization supersedes the stale one before it
 * is written; flush() drains the latest version for every key.
 *
 * @param {{
 *   write: (key: string, json: string) => Promise<void>,
 *   delayMs?: number,
 *   serialize?: (values: readonly unknown[]) => Promise<string>,
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 * }} options
 */
export function createMaterialAnnotationPersistence({
  write,
  delayMs = 1200,
  serialize = stringifyJsonArrayCooperatively,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof write !== 'function') throw new TypeError('write is required');

  const pending = new Map();
  let nextVersion = 0;
  let timer = null;
  let inFlight = null;
  let flushRequested = false;

  const clearScheduledDrain = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  const scheduleDrain = () => {
    if (timer !== null || inFlight) return;
    timer = setTimer(() => {
      timer = null;
      void drain().catch(() => {});
    }, delayMs);
  };

  const drain = (flushAll = false) => {
    if (flushAll) flushRequested = true;
    clearScheduledDrain();
    if (inFlight) return inFlight;

    inFlight = (async () => {
      do {
        const batch = Array.from(pending.entries());
        for (const [key, entry] of batch) {
          const json = await serialize(entry.values);
          await write(key, json);
          const latest = pending.get(key);
          if (latest?.version === entry.version) pending.delete(key);
        }
        if (!flushRequested) break;
      } while (pending.size > 0);
      flushRequested = false;
    })().finally(() => {
      inFlight = null;
      if (pending.size > 0) scheduleDrain();
    });

    return inFlight;
  };

  return {
    schedule(key, values) {
      nextVersion += 1;
      pending.set(key, { values, version: nextVersion });
      scheduleDrain();
    },

    flush() {
      return drain(true);
    },

    discard(key) {
      pending.delete(key);
    },

    hasPending(key) {
      return key === undefined ? pending.size > 0 : pending.has(key);
    },
  };
}
