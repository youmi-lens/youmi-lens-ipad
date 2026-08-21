/**
 * Coalesces Cloud Library Realtime events into canonical refreshes.
 *
 * Realtime is an invalidation signal only: callers fetch and merge their
 * authoritative projections themselves. A burst while a request is running
 * schedules at most one trailing refresh, which closes the snapshot race where
 * a later event lands after the first request began.
 */
export function createCloudRealtimeInvalidator(refresh) {
  let disposed = false;
  let running = false;
  let pending = false;

  const drain = async () => {
    while (!disposed && pending) {
      pending = false;
      try {
        await refresh();
      } catch {
        // Existing refresh keeps the visible cache on failure. Realtime must
        // never turn a transient channel/network failure into a blank library.
      }
    }
    running = false;
  };

  return {
    invalidate() {
      if (disposed) return;
      pending = true;
      if (running) return;
      running = true;
      void drain();
    },
    dispose() {
      disposed = true;
      pending = false;
    },
  };
}
