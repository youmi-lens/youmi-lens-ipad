/**
 * DEV-ONLY visual acceptance data. This provider is mounted only by
 * DataProvider when both __DEV__ and EXPO_PUBLIC_VISUAL_FIXTURE=1. It owns no
 * AsyncStorage, auth, Supabase, recorder, upload, quota, or IAP side effect.
 */
import { type ReactNode, useMemo, useState } from 'react';

import { DataContext, type DataContextValue } from './store';
import type { Course, CourseMaterial, Lecture, LectureMaterialLink, NoteStroke } from './models';

export const VISUAL_FIXTURE_IDS = {
  course: 'visual-fixture-course', lecture: 'visual-fixture-lecture', material: 'visual-fixture-material',
} as const;

const course: Course = {
  id: VISUAL_FIXTURE_IDS.course, name: 'Introduction to Artificial Intelligence', icon: 'git-network-outline',
  tint: '#E8F1FB', accent: '#3F73B0', createdAt: '2026-01-15T09:00:00.000Z',
};
const material: CourseMaterial = {
  id: VISUAL_FIXTURE_IDS.material, courseId: course.id, title: 'Lecture 03 — Neural Networks.pdf', fileType: 'pdf',
  localPath: '', fileSize: 2_400_000, pageCount: 18, lastOpenedPage: 6,
  createdAt: course.createdAt, updatedAt: course.createdAt,
};
const strokes: NoteStroke[] = [{
  id: 'fixture-stroke', color: '#19375C', width: 3, createdAt: course.createdAt,
  points: [{ x: 48, y: 76 }, { x: 106, y: 98 }, { x: 164, y: 72 }],
}];
const lecture: Lecture = {
  id: VISUAL_FIXTURE_IDS.lecture, courseId: course.id, title: 'How Neural Networks Learn', date: '2026-01-15T09:42:00.000Z',
  durationMillis: 762000, localAudioUri: null, remoteRecordingId: 'visual-fixture-remote', uploadStatus: 'uploaded',
  processingStatus: 'ready', markedTimestamps: [502000], status: 'ready_mock',
  transcript: 'Neural networks learn by adjusting the weights between connected layers. Each update reduces the error between a prediction and the expected result.',
  transcriptZh: '神经网络通过调整相互连接层之间的权重来学习。每次更新都会减少预测结果与预期结果之间的误差。',
  translatedTranscript: '神经网络通过调整相互连接层之间的权重来学习。',
  sourceSummary: 'This lecture explains gradient descent and the iterative adjustment of connection weights.',
  translatedSummary: '本讲介绍梯度下降以及连接权重的迭代调整。', summaryEn: 'This lecture explains gradient descent and the iterative adjustment of connection weights.', summaryZh: '本讲介绍梯度下降以及连接权重的迭代调整。',
  keyPoints: ['Weights encode connection strength', 'Gradient descent reduces error', 'Learning is iterative'],
  liveTranscript: 'Neural networks learn by adjusting the weights between connected layers.', liveTranscriptZh: '神经网络通过调整相互连接层之间的权重来学习。',
  translatedLiveTranscript: '神经网络通过调整相互连接层之间的权重来学习。',
  liveCaptionLines: [{ id: 'fixture-caption', text: 'Neural networks learn by adjusting the weights between connected layers.', translatedText: '神经网络通过调整相互连接层之间的权重来学习。' }],
  sourceLanguage: 'en', translationLanguage: 'zh-Hans', notes: 'Gradient descent → minimize loss\nReview backpropagation before next lecture.', noteStrokes: strokes, noteImages: [],
};
const link: LectureMaterialLink = { lectureId: lecture.id, materialId: material.id, lastOpenedPage: 6, createdAt: course.createdAt, updatedAt: course.createdAt };

const noop = () => undefined;
export function DevVisualFixtureDataProvider({ children }: { children: ReactNode }) {
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(course.id);
  const value = useMemo(() => {
    const base = {
      loaded: true, currentUserId: null, courses: [course], lectures: [lecture], materials: [material], materialLinks: [link],
      deletedCourses: [], deletedLectures: [], materialAnnotations: [], selectedCourseId, setSelectedCourseId,
      refreshCloudLibrary: async () => {}, getCourse: (id?: string | null) => id === course.id ? course : undefined,
      getLecture: (id?: string | null) => id === lecture.id ? lecture : undefined,
      lecturesForCourse: (id: string) => id === course.id ? [lecture] : [],
      materialsForCourse: (id: string) => id === course.id ? [material] : [], getMaterial: (id?: string | null) => id === material.id ? material : undefined,
      materialLinksForLecture: (id: string) => id === lecture.id ? [link] : [], materialLinksForMaterial: (id: string) => id === material.id ? [link] : [],
      annotationsForPage: () => [], annotationsForMaterialPage: () => [], annotationForPage: () => undefined, countAnnotationsForMaterial: () => 0,
      reserveLectureId: () => 'visual-fixture-reserved', deleteCourse: () => ({ ok: false, reason: 'course_not_empty' as const, activeLectureCount: 1 }),
      moveLectureToCourse: () => false, clearAll: async () => {},
    };
    // Any mutation path not needed for visual rendering is deliberately inert.
    return new Proxy(base, { get(target, key) { return key in target ? Reflect.get(target, key) : noop; } }) as unknown as DataContextValue;
  }, [selectedCourseId]);
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}
