// IMPORTANT: do NOT add top-level `import * as Print from 'expo-print'` here.
// On a dev client that hasn't been rebuilt with the native ExpoPrint /
// ExpoSharing pods, a static native-module import throws at module load and
// red-screens the whole lecture detail route before any try/catch can run.
// The modules are loaded inside `exportLectureNotesPdf` via guarded require()
// so a missing native module surfaces as a friendly alert, not a crash.

import { formatDate, formatDuration } from './format';
import type { Course, Lecture, NotePoint, NoteStroke } from './models';

export type ExportLectureNotesPdfInput = {
  lecture: Lecture;
  course?: Course | null;
};

export type ExportLectureNotesPdfResult = {
  uri: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nl2br(value: string): string {
  return escapeHtml(value).replace(/\n/g, '<br />');
}

function section(label: string, content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';
  return `
    <section class="section">
      <h2>${escapeHtml(label)}</h2>
      <div class="body">${nl2br(trimmed)}</div>
    </section>
  `;
}

/**
 * Same quadratic-midpoint smoothing as NotebookCanvas.strokeToPath, kept inline
 * so the print helper never imports React Native code.
 */
function strokeToSvgPathData(points: NotePoint[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const p = points[0];
    return `M ${p.x.toFixed(2)} ${p.y.toFixed(2)} L ${(p.x + 0.1).toFixed(2)} ${p.y.toFixed(2)}`;
  }
  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const midX = (points[i].x + points[i + 1].x) / 2;
    const midY = (points[i].y + points[i + 1].y) / 2;
    d += ` Q ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)} ${midX.toFixed(2)} ${midY.toFixed(2)}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x.toFixed(2)} ${last.y.toFixed(2)}`;
  return d;
}

/** Whitelist stroke colour to `#RGB` / `#RRGGBB` hex. Falls back to deep navy. */
function sanitizeStrokeColor(value: unknown): string {
  if (typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value)) return value;
  return '#061B34';
}

/** Drop NaN / Infinity / non-numeric points so a single bad sample can't break the SVG. */
function isFinitePoint(p: unknown): p is NotePoint {
  return (
    !!p &&
    typeof (p as NotePoint).x === 'number' &&
    typeof (p as NotePoint).y === 'number' &&
    Number.isFinite((p as NotePoint).x) &&
    Number.isFinite((p as NotePoint).y)
  );
}

type CleanStroke = {
  color: string;
  width: number;
  opacity: number;
  tool: 'pen' | 'highlighter';
  points: NotePoint[];
};

function cleanStroke(stroke: NoteStroke): CleanStroke | null {
  if (!stroke || !Array.isArray(stroke.points)) return null;
  const points = stroke.points.filter(isFinitePoint);
  if (points.length === 0) return null;
  const tool = stroke.tool === 'highlighter' ? 'highlighter' : 'pen';
  const maxWidth = tool === 'highlighter' ? 36 : 24;
  const width = Number.isFinite(stroke.width) && stroke.width > 0 ? Math.min(stroke.width, maxWidth) : 2;
  const opacity = Number.isFinite(stroke.opacity) ? Math.max(0, Math.min(stroke.opacity ?? 1, 1)) : (tool === 'highlighter' ? 0.34 : 1);
  return { color: sanitizeStrokeColor(stroke.color), width, opacity, tool, points };
}

function strokeToSvgElement(stroke: CleanStroke): string {
  if (stroke.points.length === 1) {
    const p = stroke.points[0];
    const r = Math.max(stroke.width / 2, 1.6);
    return `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${r.toFixed(2)}" fill="${stroke.color}" opacity="${stroke.opacity.toFixed(2)}"/>`;
  }
  return `<path d="${strokeToSvgPathData(stroke.points)}" stroke="${stroke.color}" stroke-width="${stroke.width.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" opacity="${stroke.opacity.toFixed(2)}" fill="none"/>`;
}

type Bounds = { minX: number; maxX: number; minY: number; maxY: number };

function strokeBounds(strokes: CleanStroke[]): Bounds | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const s of strokes) {
    for (const p of s.points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;
  return { minX, maxX, minY, maxY };
}

function svgForViewport(view: { x: number; y: number; w: number; h: number }, strokes: CleanStroke[]): string {
  const paths = [
    ...strokes.filter((stroke) => stroke.tool === 'highlighter'),
    ...strokes.filter((stroke) => stroke.tool !== 'highlighter'),
  ].map(strokeToSvgElement).join('');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
    `viewBox="${view.x.toFixed(2)} ${view.y.toFixed(2)} ${view.w.toFixed(2)} ${view.h.toFixed(2)}" ` +
    `preserveAspectRatio="xMidYMin meet" width="100%">` +
    paths +
    `</svg>`
  );
}

/**
 * Convert all strokes to one or more page-sized SVGs. We crop tightly to the
 * actual ink, then if the cropped page is taller than ~1.4× its width (taller
 * than a portrait PDF page would render the ink at full width), we chunk into
 * pages by source-Y rows so WebKit can paginate cleanly without scaling
 * everything down to a tiny size.
 */
export function buildHandwritingSvgPages(rawStrokes: NoteStroke[] | undefined | null): string[] {
  if (!rawStrokes || rawStrokes.length === 0) return [];

  const cleaned = rawStrokes.map(cleanStroke).filter((s): s is CleanStroke => s !== null);
  if (cleaned.length === 0) return [];

  const bounds = strokeBounds(cleaned);
  if (!bounds) return [];

  const PAD = 24;
  const viewX = bounds.minX - PAD;
  const viewYStart = bounds.minY - PAD;
  const viewW = Math.max(bounds.maxX - bounds.minX + PAD * 2, 1);
  const viewH = Math.max(bounds.maxY - bounds.minY + PAD * 2, 1);

  const MAX_PAGE_ASPECT = 1.4; // height / width
  if (viewH / viewW <= MAX_PAGE_ASPECT) {
    return [svgForViewport({ x: viewX, y: viewYStart, w: viewW, h: viewH }, cleaned)];
  }

  const chunkH = viewW * MAX_PAGE_ASPECT;
  const chunkCount = Math.ceil(viewH / chunkH);
  const pages: string[] = [];
  for (let i = 0; i < chunkCount; i += 1) {
    const yStart = viewYStart + i * chunkH;
    const yEnd = yStart + chunkH;
    // A stroke is rendered in the chunk where its first sampled point sits.
    // It may continue a few pixels past the chunk; the small overlap is fine
    // and avoids cutting strokes mid-curve.
    const strokesInChunk = cleaned.filter((s) => {
      const fy = s.points[0].y;
      return fy >= yStart && fy < yEnd;
    });
    if (strokesInChunk.length === 0) continue;
    pages.push(svgForViewport({ x: viewX, y: yStart, w: viewW, h: chunkH }, strokesInChunk));
  }
  return pages;
}

function safeFileName(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || 'lecture-notes';
}

export function hasExportableLectureNotes(lecture: Lecture): boolean {
  return Boolean(lecture.notes.trim() || (lecture.noteStrokes?.length ?? 0) > 0);
}

export function buildLectureNotesPdfHtml({ lecture, course }: ExportLectureNotesPdfInput): string {
  const typedNotes = lecture.notes.trim();
  const date = formatDate(lecture.date);
  const duration = lecture.durationMillis > 0 ? formatDuration(lecture.durationMillis) : '';
  const metaParts = [course?.name?.trim(), date, duration ? `Duration ${duration}` : ''].filter(Boolean);

  // Render real handwritten strokes as SVG pages — one or more, depending on
  // how tall the cropped ink area is.
  const svgPages = buildHandwritingSvgPages(lecture.noteStrokes);
  const hadRawStrokes = (lecture.noteStrokes?.length ?? 0) > 0;
  const handwritingHtml = svgPages.length > 0
    ? svgPages
        .map((svg, idx) => `
    <section class="handwriting${idx === 0 ? '' : ' handwriting-continued'}">
      ${idx === 0
        ? '<h2>HANDWRITTEN NOTES</h2>'
        : '<div class="handwriting-continued-label">Handwritten notes (continued)</div>'}
      <div class="ink">${svg}</div>
    </section>
        `)
        .join('')
    : hadRawStrokes
      ? `
    <section class="handwriting">
      <h2>HANDWRITTEN NOTES</h2>
      <div class="ink-fallback">Handwritten notes could not be rendered in this export.</div>
    </section>`
      : '';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    @page { margin: 42px 44px; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: #ffffff;
      color: #172238;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      font-size: 13px;
      line-height: 1.58;
    }
    .brand {
      color: #0B1F3A;
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      margin-bottom: 24px;
    }
    h1 {
      color: #0B1F3A;
      font-size: 28px;
      line-height: 1.18;
      margin: 0 0 8px;
      letter-spacing: -0.02em;
    }
    .meta {
      color: #68758A;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 28px;
    }
    .section {
      border-top: 1px solid #DCE4EF;
      padding-top: 16px;
      margin-top: 22px;
      break-inside: auto;
    }
    h2 {
      color: #0B1F3A;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin: 0 0 10px;
    }
    .body {
      white-space: normal;
      color: #22324A;
    }
    .handwriting {
      border-top: 1px solid #DCE4EF;
      padding-top: 16px;
      margin-top: 22px;
      page-break-inside: avoid;
    }
    .handwriting-continued { page-break-before: always; border-top: none; padding-top: 0; }
    .handwriting-continued-label {
      color: #8A96A8;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    .ink {
      background: #FFFFFF;
      border: 1px solid #ECEFF5;
      border-radius: 6px;
      padding: 12px;
    }
    .ink svg { display: block; width: 100%; height: auto; }
    .ink-fallback {
      color: #68758A;
      font-size: 12px;
      font-weight: 500;
      padding: 12px 0;
    }
    .footer {
      border-top: 1px solid #DCE4EF;
      color: #8A96A8;
      font-size: 11px;
      margin-top: 32px;
      padding-top: 14px;
    }
    .zh { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
  </style>
</head>
<body>
  <div class="brand">Youmi Lens</div>
  <h1>${escapeHtml(lecture.title || 'Untitled Lecture')}</h1>
  ${metaParts.length > 0 ? `<div class="meta">${escapeHtml(metaParts.join(' · '))}</div>` : ''}
  ${section('TYPED NOTES', typedNotes)}
  ${handwritingHtml}
  <div class="footer">Exported from Youmi Lens</div>
</body>
</html>`;
}

const PDF_EXPORT_UNAVAILABLE =
  'PDF export is not available in this build yet. Please rebuild the app from Xcode and try again.';

export async function exportLectureNotesPdf(input: ExportLectureNotesPdfInput): Promise<ExportLectureNotesPdfResult> {
  const html = buildLectureNotesPdfHtml(input);
  const fileName = `${safeFileName(input.lecture.title || 'lecture-notes')}-notes.pdf`;

  // Guarded runtime load. require() returns the native namespace directly
  // (unlike Metro's dynamic import(), which wraps the result and hid the
  // named exports). If the native module isn't in this dev binary, require()
  // throws here and we surface a friendly error instead of red-screening.
  let Print: any;
  let Sharing: any;
  try {
    Print = require('expo-print');
    Sharing = require('expo-sharing');
  } catch (err) {
    if (__DEV__) {
      console.warn('[pdf] failed to load expo-print / expo-sharing:', err);
    }
    throw new Error(PDF_EXPORT_UNAVAILABLE);
  }

  if (
    typeof Print?.printToFileAsync !== 'function' ||
    typeof Sharing?.shareAsync !== 'function' ||
    typeof Sharing?.isAvailableAsync !== 'function'
  ) {
    if (__DEV__) {
      // Non-sensitive diagnostic — module-shape keys only, no user data.
      console.warn(
        '[pdf] modules loaded but expected methods missing.',
        'Print keys:', Object.keys(Print ?? {}),
        'Sharing keys:', Object.keys(Sharing ?? {}),
      );
    }
    throw new Error(PDF_EXPORT_UNAVAILABLE);
  }

  const { uri } = await Print.printToFileAsync({ html, base64: false });

  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device.');
  }

  await Sharing.shareAsync(uri, {
    mimeType: 'application/pdf',
    UTI: 'com.adobe.pdf',
    dialogTitle: fileName,
  });

  return { uri };
}
