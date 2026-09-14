/**
 * Local data models for Youmi Lens for iPad.
 *
 * V1 stores everything on-device (see lib/store.tsx). There is no backend,
 * no Supabase and no AI transcription yet — transcript/summary content is
 * mock "sample" content applied after the local recording is captured.
 */

export type LectureStatus =
  /** Recording started and has meaningful content but was not finished yet;
   *  it can be reopened and continued (draft / paused / in progress). */
  | 'in_progress'
  /** Audio captured locally, not yet processed. */
  | 'local_recorded'
  /** Mock processing steps are running. */
  | 'processing_mock'
  /** Mock processing finished — sample notes available. */
  | 'ready_mock';

export type ContentLanguage = 'en' | 'zh-Hans' | 'ja' | 'fr' | 'es' | 'ko';

/**
 * A finalized bilingual caption line persisted so an in-progress lecture can be
 * reopened and its history shown again (and appended to). Mirrors the live
 * caption shape without pulling in the live-captions module.
 */
export type PersistedCaptionLine = {
  id: string;
  text: string;
  translatedText?: string;
  translationZh?: string;
};

export type TranscriptSegment = {
  time: string;
  speaker: string;
  text: string;
  /** Marked as a key sentence — highlighted on the transcript timeline. */
  important?: boolean;
};

/** A single freehand handwriting point, in canvas pixel coordinates. */
export type NotePoint = { x: number; y: number };

/** One freehand handwriting stroke on a notebook page. */
export type NoteStroke = {
  id: string;
  /** Drawing tool. Absent for old notes; treat as pen. */
  tool?: 'pen' | 'highlighter';
  /** Stroke ink colour (hex). */
  color: string;
  /** Stroke width in points. */
  width: number;
  /** Optional stroke opacity. Highlighter uses this to keep content readable. */
  opacity?: number;
  points: NotePoint[];
  /** ISO timestamp. */
  createdAt: string;
};

/** An image object placed on a notebook page. */
export type NoteImage = {
  id: string;
  /** Local file URI (expo-image-picker result). */
  uri: string;
  /** X position in canvas coordinates. */
  x: number;
  /** Y position in canvas coordinates. */
  y: number;
  /** Display width in canvas units. */
  width: number;
  /** Display height in canvas units. */
  height: number;
  /** ISO timestamp. */
  createdAt: string;
};

/** A user-created course. */
export type Course = {
  id: string;
  name: string;
  /** Ionicons glyph name. */
  icon: string;
  /** Soft tile background colour. */
  tint: string;
  /** Medium accent colour (icon + stripe). */
  accent: string;
  /** ISO timestamp. */
  createdAt: string;
  /** Soft-delete timestamp (ISO). Absent or null = active; set = in Recently Deleted. */
  deletedAt?: string | null;
  /**
   * Cloud Library Stage 4: freshness clock for the deletion STATE (a delete OR a
   * restore stamps it). Lets a stale ACTIVE snapshot never resurrect a newer
   * tombstone across devices. Mirrors Lecture.deletionUpdatedAt. See
   * lib/deletionSync.mjs.
   */
  deletionUpdatedAt?: string;
  /** Why the course was soft-deleted (e.g. 'manual'). */
  deletedReason?: string | null;
  /** Local delivery state for a course soft-delete/restore awaiting cloud confirmation. */
  deletionSyncState?: 'pending' | 'failed';
  deletionSyncError?: string;
};

/** A recorded lecture belonging to a course. */
export type LectureUploadStatus = 'not_uploaded' | 'uploading' | 'uploaded' | 'upload_failed';
export type LectureProcessingStatus = 'not_started' | 'processing' | 'ready' | 'failed';

/** Local-only evidence retained when a legacy recovered recording has multiple files. */
export type LectureAudioSegment = {
  uri: string;
  role: 'prior_canonical' | 'resumed_segment';
  createdAt: string;
};

export type Lecture = {
  id: string;
  courseId: string;
  title: string;
  /**
   * ISO timestamp of the last local title edit. Used by the cloud-merge logic
   * to keep a freshly renamed local title from being reverted by a stale
   * Supabase row before our remote update propagates. Absent for lectures
   * that have never been renamed.
   */
  titleUpdatedAt?: string;
  /** ISO timestamp of when the lecture was recorded. */
  date: string;
  durationMillis: number;
  /** Local file URI of the captured audio. */
  localAudioUri: string | null;
  /**
   * Legacy recovery can create a second audio file. Until an assembled asset is
   * validated, this blocks upload/processing and preserves every source URI.
   */
  audioAssemblyStatus?: 'required';
  audioAssemblyReason?: string;
  audioSegments?: LectureAudioSegment[];
  /**
   * ISO timestamp of when legacy-resume audio recovery successfully
   * assembled `audioSegments` into `localAudioUri`. Provenance only — the
   * source segments and their metadata are never deleted after recovery.
   */
  audioAssemblyCompletedAt?: string;
  /**
   * Recovery-time media integrity diagnostics. `recordingEngine` describes
   * only the current/last engine, not a complete media manifest — a
   * lecture can carry recoverable audio from more than one historical
   * engine. When source discovery cannot prove a safe, non-overlapping
   * order across all discovered media (see lib/recording/
   * mediaSourceDiscovery.ts), recovery is blocked rather than silently
   * uploading an incomplete subset, and this records why — auditable even
   * though nothing was lost (every source stays exactly where it was).
   */
  mediaIntegrityStatus?: 'ambiguous_overlap' | 'durable_export_failed' | 'legacy_persist_failed' | 'no_sources';
  mediaIntegrityDetail?: string;
  mediaIntegrityCheckedAt?: string;
  /**
   * `recordingEngine`/`audioAssemblyStatus` only ever describe a SINGLE
   * legacy-resume episode. A lecture that already finished that flow (and
   * even already uploaded + finished AI processing) can still be missing
   * validated media from an earlier, separate native-durable session that
   * legacy-only recovery never knew to look for — this is the general,
   * re-entrant check for that, distinct from the one-shot legacy guard so
   * the two concerns never get confused with each other.
   *   'required'  -> checked at a low-frequency boundary (Lecture Detail /
   *                  Processing open) and found validated media not yet
   *                  represented in the current canonical asset.
   *   'running'   -> discovery/export/composition in progress.
   *   'complete'  -> localAudioUri/durationMillis now reflect the full
   *                  discovered source set; mediaReconciliationSourceIds
   *                  records exactly which sources, so re-opening the
   *                  lecture again is a no-op unless NEW media appears.
   *   'ambiguous' -> extra media exists but a safe order could not be
   *                  proven; the guard from mediaSourceDiscovery.ts fired.
   *   'failed'    -> discovery ran but composition/export failed.
   * The lecture's PRE-existing canonical asset, upload, and AI results are
   * never touched while this is 'required'/'running'/'ambiguous'/'failed'
   * — they only move to reflect the corrected media once reconciliation
   * actually succeeds, so an already-Ready lecture never becomes
   * unusable because a later, more complete recovery hasn't finished yet.
   */
  mediaReconciliationStatus?: 'required' | 'running' | 'complete' | 'ambiguous' | 'failed';
  mediaReconciliationDetail?: string;
  /** Source ids (durable session ids, legacy source ids) already folded
   *  into the current canonical asset — the idempotency record. */
  mediaReconciliationSourceIds?: string[];
  mediaReconciliationCompletedAt?: string;
  /** UUID used by the backend recordings table; separate from the local lecture id. */
  remoteRecordingId?: string;
  uploadStatus?: LectureUploadStatus;
  storagePath?: string;
  uploadError?: string;
  uploadedAt?: string;
  processingStatus?: LectureProcessingStatus;
  processingError?: string;
  remoteAiStatus?: string;
  remoteAiError?: string;
  lastSyncedAt?: string;
  /** Important moments, as millisecond offsets into the recording. */
  markedTimestamps: number[];
  status: LectureStatus;
  /**
   * Which recorder produced this lecture's audio. Local-only and never sent to
   * the backend (remote writes use an explicit column allowlist). Absent on
   * lectures recorded before provenance existed — treat missing as unknown,
   * which is handled exactly like legacy.
   */
  recordingEngine?: 'legacy' | 'nativeDurable';
  sourceLanguage?: ContentLanguage;
  translationLanguage?: ContentLanguage;

  // ---- Remote study content (filled in after backend processing) ----
  // Youmi Lens V1: English lecture audio with Chinese study support. The
  // backend produces an English transcript, a Chinese transcript translated
  // from it, and English + Chinese summaries. All optional — content arrives
  // after post-class processing, and older lectures may lack newer fields.
  /** English transcript. */
  transcript?: string;
  /** Chinese transcript, translated backend-side from the English transcript. */
  transcriptZh?: string;
  translatedTranscript?: string;
  /**
   * ISO timestamp of the last local Transcript edit. Cloud merge keeps local
   * transcript fields when this is fresher than the remote row's updated_at.
   */
  transcriptUpdatedAt?: string;
  /** Summary in the lecture's source language (authoritative for multilingual lectures). */
  sourceSummary?: string;
  /** Summary in the lecture's translation language; absent when source === target. */
  translatedSummary?: string;
  /** Legacy English summary (kept for backward compatibility + language-based mirroring). */
  summaryEn?: string;
  /** Legacy Chinese summary (kept for backward compatibility + language-based mirroring). */
  summaryZh?: string;
  /**
   * ISO timestamp of the last local Summary edit. Cloud merge keeps local
   * summary fields when this is fresher than the remote row's updated_at,
   * so a manual edit is not reverted by a stale AI summary.
   */
  summaryUpdatedAt?: string;
  keyPoints: string[];
  /** Draft transcript captured from live captions during recording, when available. */
  liveTranscript?: string;
  /** Draft Chinese translation captured from live captions during recording. */
  liveTranscriptZh?: string;
  translatedLiveTranscript?: string;
  /**
   * Persisted bilingual caption history for an in-progress lecture (local only),
   * so it can be reopened, shown, and appended to when recording continues.
   */
  liveCaptionLines?: PersistedCaptionLine[];

  // ---- Local lecture notes (typed + handwritten) ----
  /** Typed notes for this lecture. */
  notes: string;
  /** Handwritten strokes for this lecture's notebook page. */
  noteStrokes?: NoteStroke[];
  /** Image objects placed on the notebook page. */
  noteImages?: NoteImage[];
  /** ISO timestamp of the last notes edit. */
  noteUpdatedAt?: string;

  // ---- Soft delete (Recently Deleted / recovery) ----
  /** Soft-delete timestamp (ISO). Absent or null = active; set = in Recently Deleted. */
  deletedAt?: string | null;
  /** Why the lecture was soft-deleted (e.g. 'manual'). */
  deletedReason?: string | null;

  // ---- Cloud Library Stage 2 field-freshness clocks (account-level sync) ----
  /** When the deletion state (delete OR restore) last changed. Drives account-level
   *  deletion merge so a stale snapshot never resurrects a newer decision. */
  deletionUpdatedAt?: string;
  /** Local delivery state for a soft-delete awaiting canonical cloud confirmation. */
  deletionSyncState?: 'pending' | 'failed';
  deletionSyncError?: string;
  /** When the notes were last edited (account-level notes freshness). */
  notesUpdatedAt?: string;
  /** When the marks were last changed (account-level marks freshness). */
  marksUpdatedAt?: string;
};

/**
 * A course-level imported study material (PDF textbooks, slides, readings).
 *
 * V1.1 (Build 7) keeps materials local-only — files live under the app's
 * Documents/materials/ directory and metadata is persisted in user-scoped
 * AsyncStorage. Cloud backup comes in V1.2. A material belongs to a Course
 * and is reused across all Lectures in that course; per-lecture metadata
 * (last opened page, page range) will live on a future LectureMaterialLink.
 */
export type CourseMaterial = {
  id: string;
  courseId: string;
  title: string;
  /** Reserved for future expansion (slides, image, etc.). PDF is the only V1 type. */
  fileType: 'pdf';
  /** Path under the app's Documents directory, e.g. 'materials/<id>.pdf'. Resolved at read time. */
  localPath: string;
  /** Bytes — surfaced in the UI; absent if the import couldn't read size metadata. */
  fileSize?: number;
  /** Number of pages — filled lazily after the PDF viewer reports it. */
  pageCount?: number;
  /** Immutable source-PDF page count once the native reader has loaded it. */
  sourcePageCount?: number;
  /** Persisted count of Youmi-owned blank pages appended after the source PDF. */
  appendedPageCount?: number;
  /** 1-based last page the user viewed. Persisted on page change. */
  lastOpenedPage?: number;
  /** Versioned, material-scoped PDFKit reading position. PDF-space anchor is layout independent. */
  lastOpenedViewport?: MaterialViewport;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp. Bumped on rename / last-page update. */
  updatedAt: string;

  // ---- Soft delete (Recently Deleted / recovery) ----
  /** Soft-delete timestamp (ISO). Absent or null = active; set = in Recently Deleted. */
  deletedAt?: string | null;
  /** Why the material was soft-deleted (e.g. 'manual'). */
  deletedReason?: string | null;
};

export type MaterialViewport = {
  version: 1;
  /** 1-based PDF/composite page identity. */
  pageIndex: number;
  scaleFactor: number;
  /** PDF page-space coordinate aligned to the viewport's top-left. */
  anchorX: number;
  anchorY: number;
};

/**
 * Per-lecture relationship to a course material.
 *
 * Materials themselves are course-level and reusable. This link records that
 * a specific lecture used a specific material, plus lecture-specific reading
 * state such as the last page opened during that lecture.
 */
export type LectureMaterialLink = {
  lectureId: string;
  materialId: string;
  /** 1-based page number last opened for this lecture/material pair. */
  lastOpenedPage?: number;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp. */
  updatedAt: string;
  /** Soft-delete timestamp (ISO). Absent or null = active. */
  deletedAt?: string | null;
  /** Why the link was removed (e.g. 'recording_abandoned', 'manual'). */
  deletedReason?: string | null;
};

export type MaterialAnnotationPoint = { x: number; y: number };

export type MaterialAnnotationTool = 'pen' | 'highlighter';

/**
 * Stroke coordinate space.
 *
 *  - `'viewport'` — points are in screen / view pixel coordinates. Produced
 *    by the legacy JS/SVG overlay spike (since rejected). Not safe to render
 *    in the native PDFKit overlay because zoom/scroll changes the mapping.
 *  - `'pdfPage'` — points are in PDFKit page coordinates and stay glued to
 *    the page across zoom/pan. Produced by the native PDFKit overlay.
 *
 * Absent → treat as `'viewport'` (backward-compat for previously stored data).
 */
export type MaterialAnnotationCoordSpace = 'viewport' | 'pdfPage';

export type MaterialAnnotationStroke = {
  id: string;
  tool: MaterialAnnotationTool;
  color: string;
  width: number;
  opacity?: number;
  points: MaterialAnnotationPoint[];
  /** Coordinate space the points live in. See MaterialAnnotationCoordSpace. */
  coordSpace?: MaterialAnnotationCoordSpace;
  createdAt: string;
};

/** Plain text placed by the student on a material PDF page. All geometry is in PDF-page points. */
export type MaterialTextAnnotation = {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  createdAt: string;
  updatedAt: string;
};

/** Local-only page annotations for one lecture/material/page tuple. */
export type MaterialPageAnnotation = {
  id: string;
  lectureId: string;
  materialId: string;
  pageNumber: number;
  strokes: MaterialAnnotationStroke[];
  /** Optional for backwards compatibility with existing ink-only records. */
  textAnnotations?: MaterialTextAnnotation[];
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  deletedReason?: string | null;
};

/** A soft academic colour + icon preset offered when creating a course. */
export type CoursePreset = {
  key: string;
  label: string;
  icon: string;
  tint: string;
  accent: string;
};

export const COURSE_PRESETS: CoursePreset[] = [
  { key: 'blue', label: 'Blue', icon: 'people-outline', tint: '#E8F1FB', accent: '#3F73B0' },
  { key: 'green', label: 'Green', icon: 'create-outline', tint: '#E7F2EA', accent: '#3F8C68' },
  { key: 'sand', label: 'Sand', icon: 'trending-up-outline', tint: '#F3ECDB', accent: '#A9802F' },
  { key: 'slate', label: 'Slate', icon: 'git-network-outline', tint: '#ECECF3', accent: '#6C6E8E' },
  { key: 'teal', label: 'Teal', icon: 'flask-outline', tint: '#E3F1F0', accent: '#3C8A86' },
  { key: 'rose', label: 'Rose', icon: 'book-outline', tint: '#F4EAEA', accent: '#A8696A' },
];
