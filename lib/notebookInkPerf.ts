/**
 * DEV-only Notebook ink recorder — the Notebook counterpart of the native
 * Course Material recorder (PdfAnnotationView.swift `InkPerfRecorder`), so a
 * device log can compare the two surfaces like for like.
 *
 * One line per finished stroke is appended to `Library/Caches/ink-perf-notebook.log`
 * (same Caches directory as the native `ink-perf.log`). Hot path cost is a few
 * arithmetic operations per sample plus a requestAnimationFrame tick while a
 * stroke is active (the JS-thread frame gap is the Notebook stall proxy, since
 * its live ink is React/SVG driven). File IO is debounced to 1.5 s AFTER writing
 * stops, never during a stroke. Callers only invoke this in the Dev bundle.
 */
type StrokeRecord = {
  startedAt: number;
  lastSampleAt: number;
  samples: number;
  gapTotal: number;
  maxGap: number;
  maxGapAt: number;
  rafFrames: number;
  rafLong: number;
  rafMaxGap: number;
  rafMaxGapAt: number;
  lastRafAt: number;
  raf: number | null;
};

const MAX_LINES = 60;
const lines: string[] = [];
let current: StrokeRecord | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

function tick(record: StrokeRecord) {
  const t = now();
  if (record.lastRafAt > 0) {
    const gap = t - record.lastRafAt;
    record.rafFrames += 1;
    if (gap > 25) record.rafLong += 1;
    if (gap > record.rafMaxGap) { record.rafMaxGap = gap; record.rafMaxGapAt = t - record.startedAt; }
  }
  record.lastRafAt = t;
  record.raf = requestAnimationFrame(() => { if (current === record) tick(record); });
}

function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      const FileSystemNS = require('expo-file-system') as typeof import('expo-file-system');
      const file = new FileSystemNS.File(FileSystemNS.Paths.cache, 'ink-perf-notebook.log');
      if (!file.exists) file.create({ intermediates: true, overwrite: true });
      file.write(lines.join('\n') + '\n');
    } catch {
      // Diagnostics must never affect the app.
    }
  }, 1500);
}

export const notebookInkPerf = {
  begin(mode: string) {
    this.cancel();
    const t = now();
    const record: StrokeRecord = {
      startedAt: t, lastSampleAt: t, samples: 0, gapTotal: 0, maxGap: 0, maxGapAt: 0,
      rafFrames: 0, rafLong: 0, rafMaxGap: 0, rafMaxGapAt: 0, lastRafAt: 0, raf: null,
    };
    current = record;
    (record as StrokeRecord & { mode?: string }).mode = mode;
    tick(record);
  },
  sample() {
    const record = current;
    if (!record) return;
    const t = now();
    const gap = t - record.lastSampleAt;
    record.lastSampleAt = t;
    record.samples += 1;
    record.gapTotal += gap;
    if (gap > record.maxGap) { record.maxGap = gap; record.maxGapAt = t - record.startedAt; }
  },
  end(commitMs: number) {
    const record = current as (StrokeRecord & { mode?: string }) | null;
    if (!record) return;
    current = null;
    if (record.raf != null) cancelAnimationFrame(record.raf);
    const dur = now() - record.startedAt;
    lines.push(
      `${new Date().toISOString()} surface=notebook mode=${record.mode ?? 'pen'} dur=${dur.toFixed(0)}ms samples=${record.samples} ` +
      `avgGap=${(record.samples > 0 ? record.gapTotal / record.samples : 0).toFixed(1)}ms maxGap=${record.maxGap.toFixed(1)}ms@${record.maxGapAt.toFixed(0)}ms ` +
      `jsFrames=${record.rafFrames} jsLong(>25ms)=${record.rafLong} jsMaxFrame=${record.rafMaxGap.toFixed(1)}ms@${record.rafMaxGapAt.toFixed(0)}ms commit=${commitMs.toFixed(1)}ms`,
    );
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    scheduleFlush();
  },
  cancel() {
    if (current?.raf != null) cancelAnimationFrame(current.raf);
    current = null;
  },
};
