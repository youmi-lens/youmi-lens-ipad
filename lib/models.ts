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
