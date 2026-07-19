import { resolveRecordingEngine } from './recording/featureGate';
import type { LectureRecorder } from './recording/types';
import { useLegacyLectureRecorder } from './recording/useLegacyLectureRecorder';
import { useNativeDurableLectureRecorder } from './recording/useNativeDurableLectureRecorder';

export type { LectureRecorder, RecorderPermission } from './recording/types';
export type { RecordingEngine } from './recording/featureGate';

export function useLectureRecorder(options: { lectureId: string; forceLegacy?: boolean }): LectureRecorder {
  const engine = resolveRecordingEngine(options.forceLegacy === true);
  const legacy = useLegacyLectureRecorder(engine === 'legacy');
  const nativeDurable = useNativeDurableLectureRecorder(engine === 'nativeDurable', options.lectureId);
  return engine === 'nativeDurable' ? nativeDurable : legacy;
}
