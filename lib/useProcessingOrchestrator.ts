/**
 * Durable post-Finish processing orchestrator.
 *
 * Once the user taps "Finish lecture" the lecture is committed, and its
 * upload → backend-processing → status-poll chain must complete regardless of
 * which screen is on-screen. Previously this chain lived in the processing
 * screen's effects, so navigating away (Back to lecture/course/home) before it
 * finished left the lecture stuck: uploaded-but-never-triggered, or frozen at
 * "uploading" after an app kill.
 *
 * This hook is mounted once at the app root (see app/_layout.tsx). It watches
 * every committed lecture and idempotently drives whatever step is still
 * pending — on app start, on foreground (the store re-reads status then, which
 * flows back in through `lectures`), and whenever a lecture's status changes.
 * The processing screen is now only a viewer of this state.
 *
 * Idempotency: pure decisions live in processingResume.mjs; this layer adds
 * in-flight guards so a re-render or a concurrent screen can never launch a
 * second upload / trigger / poll for the same lecture. Remote work is keyed by
 * the stable remoteRecordingId, so retries never create duplicate recordings.
 */
import { useEffect, useRef } from 'react';

import { useAuth } from './auth';
import { startRemoteProcessing } from './processRecording';
import { nextProcessingAction, mergeProcessingSnapshot } from './processingResume.mjs';
import { useData } from './store';
import { fetchRemoteRecording } from './syncRecording';
import { uploadLectureAudio } from './uploadRecording';

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 80;

export function useProcessingOrchestrator(): void {
  const { loaded, lectures, getCourse, updateLecture } = useData();
  const { session } = useAuth();

  const accessToken = session?.access_token ?? null;
  const userId = session?.user?.id ?? null;

  const uploadingRef = useRef<Set<string>>(new Set());
  const startingRef = useRef<Set<string>>(new Set());
  const pollingRef = useRef<Map<string, { attempts: number; timer: ReturnType<typeof setTimeout> | null; cancelled: boolean }>>(
    new Map(),
  );

  // Cancel every in-flight poll on unmount (app teardown / account switch).
  useEffect(() => {
    const polling = pollingRef.current;
    return () => {
      polling.forEach((state) => {
        state.cancelled = true;
        if (state.timer) clearTimeout(state.timer);
      });
      polling.clear();
    };
  }, []);

  useEffect(() => {
    if (!loaded || !accessToken || !userId) return;

    const startUpload = (lectureId: string, remoteRecordingId: string) => {
      if (uploadingRef.current.has(lectureId)) return;
      const lecture = lectures.find((l) => l.id === lectureId);
      if (!lecture || !lecture.localAudioUri) return;
      uploadingRef.current.add(lectureId);
      updateLecture(lectureId, { uploadStatus: 'uploading', uploadError: undefined });
      void uploadLectureAudio({
        localUri: lecture.localAudioUri,
        lectureId: lecture.id,
        recordingId: remoteRecordingId,
        mimeType: 'audio/m4a',
        accessToken,
        durationMillis: lecture.durationMillis,
        course: getCourse(lecture.courseId)?.name,
        // Canonical Course identity → the row is linked at first insert.
        courseId: lecture.courseId,
        title: lecture.title,
        liveTranscript: lecture.liveTranscript,
        translatedLiveTranscript: lecture.translatedLiveTranscript,
        sourceLanguage: lecture.sourceLanguage ?? 'en',
        translationLanguage: lecture.translationLanguage ?? 'zh-Hans',
      })
        .then((result) => {
          // Cloud Marks V1 activation: the audio upload just created the cloud
          // `recordings` row (id === remoteRecordingId), so this is the first
          // moment the marks captured at Finish have a row to attach to. The
          // audio-upload payload does NOT carry marks, so without this they stay
          // device-local forever. Including `markedTimestamps` here makes the
          // store's existing writer push `marked_timestamps` + `marks_updated_at`
          // exactly once, best-effort. Local marks were already saved at Finish;
          // this never blocks upload, Finish, navigation, or playback, and an
          // upload failure simply leaves them local to re-sync on the next upload.
          updateLecture(lectureId, {
            uploadStatus: 'uploaded',
            storagePath: result.storagePath,
            uploadError: undefined,
            uploadedAt: new Date().toISOString(),
            markedTimestamps: lecture.markedTimestamps ?? [],
          });
        })
        .catch((error: unknown) => {
          updateLecture(lectureId, {
            uploadStatus: 'upload_failed',
            uploadError: error instanceof Error ? error.message : 'Upload failed.',
          });
        })
        .finally(() => {
          uploadingRef.current.delete(lectureId);
        });
    };

    const startProcessing = (lectureId: string, remoteRecordingId: string) => {
      if (startingRef.current.has(lectureId)) return;
      startingRef.current.add(lectureId);
      // Do NOT optimistically mark 'processing' before the request. If the
      // backend rejects the trigger (e.g. HTTP 503 "AI unavailable" on a dev
      // backend with no transcription provider), we must land on a terminal
      // 'failed' immediately. Marking 'processing' first caused the poll loop to
      // start; that poll then read the never-enqueued remote ai_status
      // ('pending') and overwrote the 'failed' back to a waiting state for the
      // whole poll budget — the "stuck on Waiting…" symptom. Only a SUCCESSFUL
      // trigger enters 'processing' (and thus polling); a failure is terminal.
      void startRemoteProcessing({ remoteRecordingId, accessToken })
        .then(() => {
          updateLecture(lectureId, { processingStatus: 'processing', processingError: undefined });
        })
        .catch((error: unknown) => {
          updateLecture(lectureId, {
            processingStatus: 'failed',
            processingError: error instanceof Error ? error.message : 'Could not start processing.',
          });
        })
        .finally(() => {
          startingRef.current.delete(lectureId);
        });
    };

    const startPoll = (lectureId: string, remoteRecordingId: string) => {
      if (pollingRef.current.has(lectureId)) return;
      const state = { attempts: 0, timer: null as ReturnType<typeof setTimeout> | null, cancelled: false };
      pollingRef.current.set(lectureId, state);

      const stop = () => {
        state.cancelled = true;
        if (state.timer) clearTimeout(state.timer);
        pollingRef.current.delete(lectureId);
      };

      const tick = async () => {
        if (state.cancelled) return;
        state.attempts += 1;
        try {
          const remote = await fetchRemoteRecording({ remoteRecordingId, accessToken, userId });
          if (state.cancelled) return;

          const reference = lectures.find((l) => l.id === lectureId) ?? {};
          const patch = mergeProcessingSnapshot(reference, remote);
          updateLecture(lectureId, { ...patch, lastSyncedAt: new Date().toISOString() });

          if (patch.processingStatus === 'ready' || patch.processingStatus === 'failed') {
            stop();
            return;
          }
          if (state.attempts >= MAX_POLL_ATTEMPTS) {
            updateLecture(lectureId, {
              processingStatus: 'failed',
              processingError: 'Processing is taking longer than expected. Please retry in a moment.',
            });
            stop();
            return;
          }
          state.timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
        } catch (error) {
          if (state.cancelled) return;
          updateLecture(lectureId, {
            processingStatus: 'failed',
            processingError: error instanceof Error ? error.message : 'Could not sync processing status.',
          });
          stop();
        }
      };

      void tick();
    };

    for (const lecture of lectures) {
      const action = nextProcessingAction(lecture);
      const remoteRecordingId = lecture.remoteRecordingId;
      if (!remoteRecordingId) continue;
      if (action === 'upload') startUpload(lecture.id, remoteRecordingId);
      else if (action === 'start_processing') startProcessing(lecture.id, remoteRecordingId);
      else if (action === 'poll') startPoll(lecture.id, remoteRecordingId);
    }
  }, [loaded, lectures, accessToken, userId, getCourse, updateLecture]);
}
