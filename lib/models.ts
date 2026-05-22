/**
 * Local data models for Youmi Lens for iPad.
 *
 * V1 stores everything on-device (see lib/store.tsx). There is no backend,
 * no Supabase and no AI transcription yet — transcript/summary content is
 * mock "sample" content applied after the local recording is captured.
 */

export type LectureStatus =
  /** Audio captured locally, not yet processed. */
  | 'local_recorded'
  /** Mock processing steps are running. */
  | 'processing_mock'
  /** Mock processing finished — sample notes available. */
  | 'ready_mock';

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
  /** Stroke ink colour (hex). */
  color: string;
  /** Stroke width in points. */
  width: number;
  points: NotePoint[];
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
  /** Why the course was soft-deleted (e.g. 'manual'). */
  deletedReason?: string | null;
};

/** A recorded lecture belonging to a course. */
export type LectureUploadStatus = 'not_uploaded' | 'uploading' | 'uploaded' | 'upload_failed';
export type LectureProcessingStatus = 'not_started' | 'processing' | 'ready' | 'failed';

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

  // ---- Remote study content (filled in after backend processing) ----
  // Youmi Lens V1: English lecture audio with Chinese study support. The
  // backend produces an English transcript, a Chinese transcript translated
  // from it, and English + Chinese summaries. All optional — content arrives
  // after post-class processing, and older lectures may lack newer fields.
  /** English transcript. */
  transcript?: string;
  /** Chinese transcript, translated backend-side from the English transcript. */
  transcriptZh?: string;
  /** English summary. */
  summaryEn?: string;
  /** Chinese summary. */
  summaryZh?: string;
  keyPoints: string[];
  /** Draft transcript captured from live captions during recording, when available. */
  liveTranscript?: string;

  // ---- Local lecture notes (typed + handwritten) ----
  /** Typed notes for this lecture. */
  notes: string;
  /** Handwritten strokes for this lecture's notebook page. */
  noteStrokes?: NoteStroke[];
  /** ISO timestamp of the last notes edit. */
  noteUpdatedAt?: string;

  // ---- Soft delete (Recently Deleted / recovery) ----
  /** Soft-delete timestamp (ISO). Absent or null = active; set = in Recently Deleted. */
  deletedAt?: string | null;
  /** Why the lecture was soft-deleted (e.g. 'manual'). */
  deletedReason?: string | null;
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
  /** 1-based last page the user viewed. Persisted on page change. */
  lastOpenedPage?: number;
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

/** Local-only page annotations for one lecture/material/page tuple. */
export type MaterialPageAnnotation = {
  id: string;
  lectureId: string;
  materialId: string;
  pageNumber: number;
  strokes: MaterialAnnotationStroke[];
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
