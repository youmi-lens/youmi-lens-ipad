/**
 * Mock content for Youmi Lens for iPad V1.
 *
 * Courses and lectures are real local user data (lib/store.tsx). What remains
 * here is honest interface filler — there is NO fake live transcription:
 *  - the processing step list (clearly labelled "mock")
 *  - the user profile + plan (cosmetic)
 *  - MOCK_LECTURE_CONTENT — sample study notes used as fallback demo content.
 *    It is always presented as sample content, never as real transcription.
 */
import type { TranscriptSegment } from '@/lib/models';

export type ProcessingStep = {
  key: string;
  title: string;
  subtitle: string;
};

export const user = {
  firstName: 'Ayden',
  fullName: 'Ayden Chen',
  email: 'ayden.chen@university.edu',
  initials: 'AC',
};

export const plan = {
  name: 'Unlimited',
  usedMinutes: 1200,
  totalLabel: 'Unlimited',
  /** Decorative fill for the progress bar (0–1). */
  progress: 0.58,
  renewLabel: 'Renews June 1, 2026',
};

/**
 * Mock post-recording steps. Real audio is saved locally; the rest are
 * placeholders until transcription is connected — labelled honestly as "mock".
 */
export const processingSteps: ProcessingStep[] = [
  {
    key: 'upload',
    title: 'Saving audio locally',
    subtitle: 'Storing your recording on this device',
  },
  {
    key: 'transcribe',
    title: 'Mock transcription preview',
    subtitle: 'Placeholder — real transcription is not connected yet',
  },
  {
    key: 'summary-en',
    title: 'Mock English summary',
    subtitle: 'Sample content for layout preview',
  },
  {
    key: 'summary-zh',
    title: 'Mock Chinese summary',
    subtitle: '示例内容，用于界面预览',
  },
  {
    key: 'keypoints',
    title: 'Mock key points',
    subtitle: 'Sample content for layout preview',
  },
];

/**
 * Sample study content used as fallback demo content on the Lecture Detail
 * screen. This is NOT real transcription — every screen that shows it must
 * label it clearly as sample content.
 */
export const MOCK_LECTURE_CONTENT: {
  transcript: TranscriptSegment[];
  summaryEn: string;
  summaryZh: string;
  keyPoints: string[];
} = {
  transcript: [
    {
      time: '00:00',
      speaker: 'Lecturer',
      text: 'Welcome back. Today we will work through the core concepts for this unit and look at a few worked examples.',
    },
    {
      time: '03:12',
      speaker: 'Lecturer',
      text: 'The first idea to hold onto is that each concept builds directly on the one before it.',
      important: true,
    },
    {
      time: '08:45',
      speaker: 'Lecturer',
      text: 'Let us walk through a worked example so you can see how the theory applies in practice.',
    },
    {
      time: '15:30',
      speaker: 'Lecturer',
      text: 'Remember this distinction — it is the part students most often get wrong on the exam.',
      important: true,
    },
    {
      time: '21:00',
      speaker: 'Lecturer',
      text: 'We will finish with a short summary and a preview of next week’s reading.',
    },
  ],
  summaryEn:
    'A clear walkthrough of this unit’s core concepts with worked examples. The lecturer emphasised how each idea builds on the previous one, flagged a common exam mistake, and closed with a preview of next week’s reading.',
  summaryZh:
    '本节课清晰地讲解了本单元的核心概念，并配有例题。讲师强调了每个概念之间的递进关系，指出了考试中常见的错误，并在课程结尾预告了下周的阅读内容。',
  keyPoints: [
    'Each concept builds directly on the one before it.',
    'Worked examples show how to apply the theory in practice.',
    'Watch the key distinction — it is a common exam mistake.',
    'Review tonight and complete next week’s reading.',
  ],
};
