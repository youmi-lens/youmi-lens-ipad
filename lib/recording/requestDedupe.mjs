/**
 * Minimal single-flight helper.
 *
 * Keeps at most one in-flight request per key, so re-renders, a development
 * double-mount, or several components asking at once share a single request
 * instead of stampeding the backend. Deliberately tiny and dependency-free —
 * this is not a caching layer, and it holds no result after settling.
 */
export function createRequestDeduper() {
  const inFlight = new Map();

  return {
    /**
     * Runs `start()` for `key`, or returns the existing in-flight promise.
     * `onDeduplicated` fires when an existing request was reused.
     */
    run(key, start, onDeduplicated) {
      const existing = inFlight.get(key);
      if (existing) {
        if (typeof onDeduplicated === 'function') onDeduplicated();
        return existing;
      }
      // `start()` runs synchronously so the request is genuinely in flight by
      // the time this returns, but a synchronous throw is converted into a
      // rejected promise so the key is always released rather than wedged.
      let request;
      try {
        request = Promise.resolve(start());
      } catch (error) {
        request = Promise.reject(error);
      }
      const tracked = request.finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, tracked);
      return tracked;
    },

    /** Number of requests currently in flight. Used by tests. */
    size() {
      return inFlight.size;
    },

    /** Drops all in-flight tracking. Used by tests and on sign-out. */
    clear() {
      inFlight.clear();
    },
  };
}
