/**
 * Integrated Simulated Tutorial — the six simulated Youmi Lens screens.
 *
 * Each screen is a full-context visual replica of its real counterpart, built
 * from the same design-system primitives AND the same production i18n copy
 * (`home.*`, `courses.*`, `course.*`, `recording.*`, `lecture.tab.*`) so a
 * user who finishes the tour recognises the real screen immediately.
 *
 * A screen stays MOUNTED across every teaching moment that shares it — the
 * Recording screen alone carries start → captions → translation → dictionary
 * → mark → pause/resume → (iPad: notebook entry) → finish, and its simulated
 * timer keeps running throughout. Only the internal focus changes.
 *
 * Pure production components reused directly (verified free of store /
 * network / navigation side effects): CourseCard, GlassCard, PressableScale,
 * StatusPill, IconTile, PageHeading, ProgressBar, PrimaryButton,
 * SecondaryButton, LogoMark. Components whose mount triggers real side
 * effects — CaptionHistoryFeed (pulls the native dictionary module),
 * NotebookCanvas, TranscriptReadList, YLSidebar — are replicated here
 * instead, matching their layout language.
 *
 * Nothing here reads or writes real Course/Lecture/Material/Notebook state,
 * Supabase, the recorder, quota, or uploads. Every value below is local
 * component state, discarded when the tour closes.
 */
import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { LogoMark } from '@/components/BrandHeader';
import { CourseCard } from '@/components/CourseCard';
import { GlassCard } from '@/components/GlassCard';
import { PrimaryButton } from '@/components/PrimaryButton';
import { SecondaryButton } from '@/components/SecondaryButton';
import { StatusPill } from '@/components/StatusPill';
import { IconTile, PageHeading, ProgressBar } from '@/components/WorkspaceUI';
import { isPad } from '@/constants/deviceClass';
import { useIsCompactWidth } from '@/constants/responsive';
import { colors, fontSize, radius, spacing } from '@/constants/theme';
import { useT } from '@/lib/i18n';
import { useTutorialTour } from '@/lib/tutorialTour';
import { DEMO_CONTENT, DEMO_COURSE_VISUAL, LECTURE_TABS } from '@/lib/tutorialTourCore.mjs';

import { ActionTarget, Emphasis, SoftDim } from './TourEmphasis';

type ScreenProps = { moment: string };

/**
 * Production decides LAYOUT by live window width (`useIsCompactWidth`, the
 * 900pt breakpoint), not by device class — an iPad Pro 11" is 834pt in
 * portrait and therefore uses the compact layout there, switching to the wide
 * one only in landscape. The simulated screens follow the same rule so the
 * tour matches the real app in both orientations and re-lays-out on rotation.
 *
 * `isPad` stays reserved for CAPABILITY (does Notebook exist at all), never
 * for layout.
 */

/** Moment order within the Recording screen, for "at or past" comparisons. */
const RECORDING_ORDER = [
  'recording_start',
  'captions',
  'translation',
  'dictionary',
  'mark_important',
  'pause_resume',
  'notebook_open',
  'notebook_note',
  'finish',
];
const atOrPast = (moment: string, target: string) =>
  RECORDING_ORDER.indexOf(moment) >= RECORDING_ORDER.indexOf(target);

function formatClock(totalSeconds: number) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Word-by-word reveal, so captions read as live transcription. */
function useProgressiveWords(text: string, run: boolean, stepMs = 190) {
  const [count, setCount] = useState(0);
  const words = text.split(' ');
  useEffect(() => {
    if (!run) return;
    setCount(0);
    const id = setInterval(() => {
      setCount((c) => {
        if (c >= words.length) {
          clearInterval(id);
          return c;
        }
        return c + 1;
      });
    }, stepMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, text, stepMs]);
  return words.slice(0, count).join(' ');
}

// =====================================================================
// Home — mirrors app/(tabs)/index.tsx (new-user empty state)
// =====================================================================
export function SimulatedHomeScreen({ moment }: ScreenProps) {
  const t = useT();
  const isCompact = useIsCompactWidth();
  const emphasiseCreate = moment === 'create_course';

  return (
    <ScrollView contentContainerStyle={[styles.pageScroll, !isCompact && styles.pageScrollWide]} showsVerticalScrollIndicator={false}>
      <View style={styles.pageContent}>
        <PageHeading eyebrow={t('home.welcome')} title={t('home.title')} preserveEyebrowCase />

        <GlassCard elevated style={styles.heroCard}>
          <LogoMark size={36} />
          <Text style={[styles.heroTitle, !isCompact && styles.heroTitleWide]}>{t('home.createFirstCourse')}</Text>
          <Text style={styles.heroBody}>{t('home.emptyBody')}</Text>
          <View style={styles.heroActions}>
            <ActionTarget momentId="create_course" active={emphasiseCreate} radiusOverride={radius.lg}>
              <PrimaryButton label={t('home.createCourse')} icon="add" />
            </ActionTarget>
            <SoftDim active={emphasiseCreate}>
              <SecondaryButton label={t('home.quickRecording')} icon="mic-outline" />
            </SoftDim>
          </View>
        </GlassCard>

        <SoftDim active={emphasiseCreate}>
          <GlassCard style={styles.stepsCard}>
            {[
              ['home.onboarding.recordTitle', 'home.onboarding.recordBody'],
              ['home.onboarding.reviewTitle', 'home.onboarding.reviewBody'],
              ['home.onboarding.notesTitle', 'home.onboarding.notesBody'],
            ].map(([titleKey, bodyKey], index) => (
              <View key={titleKey} style={styles.step}>
                <View style={styles.stepNumber}><Text style={styles.stepNumberText}>{index + 1}</Text></View>
                <View style={styles.stepText}>
                  <Text style={styles.stepTitle}>{t(titleKey)}</Text>
                  <Text style={styles.stepBody}>{t(bodyKey)}</Text>
                </View>
              </View>
            ))}
          </GlassCard>
        </SoftDim>
      </View>
    </ScrollView>
  );
}

// =====================================================================
// Courses — mirrors app/(tabs)/courses.tsx
// =====================================================================
export function SimulatedCoursesScreen({ moment }: ScreenProps) {
  const t = useT();
  const isCompact = useIsCompactWidth();
  const emphasise = moment === 'courses_list';
  // Shaped exactly like a real Course record so the PURE production
  // <CourseCard/> renders it unchanged. Never inserted into any store.
  const demoCourse = {
    ...DEMO_COURSE_VISUAL,
    name: t(DEMO_CONTENT.courseNameKey),
  } as never;

  return (
    <ScrollView contentContainerStyle={[styles.pageScroll, !isCompact && styles.pageScrollWide]} showsVerticalScrollIndicator={false}>
      <View style={styles.pageContent}>
        <PageHeading
          eyebrow={t('courses.library')}
          title={t('courses.title')}
          subtitle={t(DEMO_CONTENT.courseMetaKey)}
        />
        <View style={styles.grid}>
          <ActionTarget
            momentId="courses_list"
            active={emphasise}
            style={isCompact ? styles.gridItem : styles.gridItemWide}
            radiusOverride={20}
          >
            <CourseCard course={demoCourse} lectureCount={0} readyCount={0} />
          </ActionTarget>
          <SoftDim active={emphasise} style={isCompact ? styles.gridItem : styles.gridItemWide}>
            <View style={styles.ghostCard}>
              <View style={styles.plus}><Ionicons name="add" size={22} color={colors.navy} /></View>
              <Text style={styles.ghostLabel}>{t('courses.new')}</Text>
            </View>
          </SoftDim>
        </View>
      </View>
    </ScrollView>
  );
}

// =====================================================================
// Course Detail — mirrors app/course/[id].tsx
// =====================================================================
export function SimulatedCourseDetailScreen({ moment }: ScreenProps) {
  const t = useT();
  const isCompact = useIsCompactWidth();
  // Two moments share this one shell: course_material teaches "this is what
  // lives inside a course", start_lecture then teaches the real entry point
  // for beginning a lecture FROM that course context (§2) — both dim
  // everything else on the page so only the taught region reads as active.
  const emphasiseMaterial = moment === 'course_material';
  const emphasiseStart = moment === 'start_lecture';
  const anyEmphasis = emphasiseMaterial || emphasiseStart;

  return (
    <View style={styles.stackScreen}>
      <View style={[styles.stackHeader, !isCompact && styles.stackHeaderWide]}>
        <View style={styles.headerIconBtn}><Ionicons name="chevron-back" size={22} color={colors.textPrimary} /></View>
        <Text style={styles.stackHeaderTitle} numberOfLines={1}>{t('course.detail')}</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={[styles.pageScroll, !isCompact && styles.pageScrollWide]} showsVerticalScrollIndicator={false}>
        <View style={styles.pageContent}>
          <SoftDim active={anyEmphasis && !emphasiseStart}>
            <GlassCard>
              <View style={styles.courseSummaryRow}>
                <IconTile icon="sparkles-outline" size={44} color={colors.accent} backgroundColor={colors.surfaceMuted} />
                <View style={styles.courseSummaryText}>
                  <Text style={styles.courseSummaryName} numberOfLines={2}>{t(DEMO_CONTENT.courseNameKey)}</Text>
                  <Text style={styles.courseSummaryMeta}>{t('course.noRecordings')}</Text>
                </View>
              </View>
              <ActionTarget momentId="start_lecture" active={emphasiseStart} radiusOverride={radius.lg}>
                <PrimaryButton label={t('course.start')} icon="mic" style={styles.startButton} />
              </ActionTarget>
            </GlassCard>
          </SoftDim>

          <SoftDim active={emphasiseStart}>
            <Text style={styles.sectionTitle}>{t('course.materials')}</Text>
            <ActionTarget momentId="course_material" active={emphasiseMaterial} radiusOverride={radius.xl}>
              <GlassCard>
                <Text style={styles.materialsLocalNote}>{t('course.materialsLocal')}</Text>
                <View style={styles.materialRow}>
                  <View style={styles.materialIcon}>
                    <Ionicons name="document-text-outline" size={19} color={colors.textPrimary} />
                  </View>
                  <View style={styles.materialText}>
                    <Text style={styles.materialName} numberOfLines={1}>{t(DEMO_CONTENT.materialNameKey)}</Text>
                    <Text style={styles.materialMeta}>{t(DEMO_CONTENT.materialMetaKey)}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
                </View>
              </GlassCard>
            </ActionTarget>

            <Text style={styles.sectionTitle}>{t('course.lectures')}</Text>
            <GlassCard style={styles.emptyLectures}>
              <Text style={styles.emptyLecturesText}>{t('course.noLectures')}</Text>
            </GlassCard>
          </SoftDim>
        </View>
      </ScrollView>
    </View>
  );
}

// =====================================================================
// Recording — mirrors app/recording.tsx. ONE shell, many moments.
// =====================================================================
export function SimulatedRecordingScreen({ moment }: ScreenProps) {
  const t = useT();
  const isCompact = useIsCompactWidth();
  const line = t(DEMO_CONTENT.transcriptLineKey);
  const word = t(DEMO_CONTENT.dictionaryWordKey);

  // Elapsed time and pause belong to the simulated SESSION, not to this
  // screen — the journey leaves for Notebook and comes back, which remounts
  // this component, and a local clock would restart the lecture at zero.
  const { demoElapsedSeconds: seconds, demoPaused: paused, advanceFromTarget } = useTutorialTour();

  const [dictOpen, setDictOpen] = useState(false);
  const lastTapRef = useRef(0);

  // The dictionary demonstrates itself shortly after arriving, so a user who
  // does not try the gesture is never stuck; a real double-tap opens it early.
  useEffect(() => {
    if (moment !== 'dictionary') {
      setDictOpen(false);
      return;
    }
    const id = setTimeout(() => setDictOpen(true), 900);
    return () => clearTimeout(id);
  }, [moment]);

  const captionsOn = atOrPast(moment, 'captions');
  const revealed = useProgressiveWords(line, moment === 'captions');
  const captionText = moment === 'captions' ? revealed : captionsOn ? line : '';
  const showTranslation = atOrPast(moment, 'translation');

  // The taught gesture is the double-tap. First double-tap reveals the
  // definition (the outcome the user needs to see); once it is on screen, a
  // tap on the same word continues the tour — so the word itself is both the
  // lesson and the way forward, and there is no Next competing with it.
  const handleWordTap = () => {
    if (dictOpen) {
      advanceFromTarget('dictionary');
      return;
    }
    const now = Date.now();
    if (now - lastTapRef.current < 350) {
      // The taught gesture is a double tap. Its second tap must both reveal
      // the simulated definition and complete this action moment; requiring a
      // third tap stranded the live tutorial on the dictionary instruction.
      setDictOpen(true);
      advanceFromTarget('dictionary');
      // React Native can batch the two presses belonging to a double-tap.
      // Re-attempt after that state commit: the tour provider's advance lock
      // makes this idempotent, but avoids leaving the guide on this step.
      requestAnimationFrame(() => advanceFromTarget('dictionary'));
    }
    lastTapRef.current = now;
  };

  const parts = line.split(new RegExp(`(${word})`, 'i'));
  const isDictMoment = moment === 'dictionary';

  return (
    <View style={styles.stackScreen}>
      {/* Header — mirrors app/recording.tsx: back, state pill, course chip,
          timer, then (iPad only) the Material chip and the Mini entry. Mini
          lives up here on iPad and in the bottom bar on phone — matching that
          split is the whole point of a location-memory tour. */}
      <View style={[styles.recHeader, isCompact && styles.recHeaderCompact]}>
        <View style={styles.headerIconBtn}><Ionicons name="chevron-back" size={24} color={colors.textPrimary} /></View>
        <StatusPill
          label={paused ? t('recording.pausedShort') : t('recording.recordingShort')}
          variant={paused ? 'paused' : 'recording'}
        />
        <View style={[styles.courseChip, isCompact && styles.courseChipCompact]}>
          <Ionicons name="sparkles-outline" size={13} color={colors.accent} />
          <Text style={styles.courseChipText} numberOfLines={1}>{t(DEMO_CONTENT.courseNameKey)}</Text>
        </View>
        <Text style={[styles.headerTimer, isCompact && styles.headerTimerCompact]}>{formatClock(seconds)}</Text>
        {isCompact ? (
          <Ionicons name="document-text-outline" size={17} color={colors.textTertiary} />
        ) : (
          <>
            <View style={styles.materialTopButton}>
              <Ionicons name="document-text-outline" size={14} color={colors.textTertiary} />
              <Text style={styles.materialTopText}>{t('recording.materialTop')}</Text>
            </View>
            {isPad ? (
              <ActionTarget
                momentId="notebook_open"
                active={moment === 'notebook_open'}
                radiusOverride={radius.pill}
                accessibilityLabel={t('recording.miniLabel')}
              >
                <View style={styles.iconBtnLabelled}>
                  <Ionicons name="contract-outline" size={19} color={colors.textPrimary} />
                  <Text style={styles.iconBtnLabel}>{t('recording.miniLabel')}</Text>
                </View>
              </ActionTarget>
            ) : null}
          </>
        )}
      </View>

      {/* Caption stage */}
      <View style={[styles.feedRegion, !isCompact && styles.feedRegionWide]}>
        {captionsOn ? (
          <View style={styles.captionBlock}>
            {isDictMoment ? (
              <Text style={[styles.captionEnglish, !isCompact && styles.captionEnglishWide]}>
                {parts.map((part, i) =>
                  part.toLowerCase() === word.toLowerCase() ? (
                    <Text
                      key={i}
                      accessibilityRole="button"
                      accessibilityLabel={word}
                      onPress={handleWordTap}
                      style={styles.dictWord}
                    >
                      {part}
                    </Text>
                  ) : (
                    <Text key={i}>{part}</Text>
                  ),
                )}
              </Text>
            ) : (
              <Text style={[styles.captionEnglish, !isCompact && styles.captionEnglishWide]}>{captionText || ' '}</Text>
            )}
            {showTranslation ? (
              <Text style={[styles.captionTranslated, !isCompact && styles.captionTranslatedWide]}>{t(DEMO_CONTENT.translationLineKey)}</Text>
            ) : null}
          </View>
        ) : (
          <Text style={styles.preparing}>{t('recording.preparingMic')}</Text>
        )}

        {dictOpen ? (
          <View style={styles.dictSheet}>
            <Text style={styles.dictWordTitle}>{word}</Text>
            <Text style={styles.dictDefinition}>{t(DEMO_CONTENT.dictionaryDefinitionKey)}</Text>
          </View>
        ) : null}

        {moment === 'mark_important' ? (
          <View style={styles.markToast}>
            <Ionicons name="star" size={14} color={colors.pearlWhite} />
            <Text style={styles.markToastText}>{t('tutorialTour.markedToast')}</Text>
          </View>
        ) : null}
      </View>

      {/* Controls — geometry copied from app/recording.tsx's `actions` bar:
          a full-width glass strip with a hairline top border. On iPad Mark
          Important is a flexed SecondaryButton and Mini is NOT here (it is in
          the header); on phone both are small round utility buttons. */}
      <SoftDim active={isDictMoment}>
        <View style={[styles.controlsRow, isCompact && styles.controlsRowCompact]}>
          <ActionTarget
            momentId="mark_important"
            active={moment === 'mark_important'}
            radiusOverride={isCompact ? radius.pill : radius.md}
            style={isCompact ? undefined : styles.sideAction}
            accessibilityLabel={t('recording.markImportant')}
          >
            {isCompact ? (
              <View style={styles.utilityBtn}>
                <Ionicons name="star-outline" size={20} color={colors.textPrimary} />
              </View>
            ) : (
              <SecondaryButton label={t('recording.markImportant')} icon="star" />
            )}
          </ActionTarget>

          {/* At compact width the Mini entry lives down here, exactly as in
              production — so on an iPad in portrait the Notebook moment is
              emphasised on this button, and in landscape on the header one. */}
          {isCompact && isPad ? (
            <ActionTarget
              momentId="notebook_open"
              active={moment === 'notebook_open'}
              radiusOverride={radius.pill}
              accessibilityLabel={t('recording.miniLabel')}
            >
              <View style={styles.utilityBtn}>
                <Ionicons name="contract-outline" size={20} color={colors.textPrimary} />
              </View>
            </ActionTarget>
          ) : null}

          <ActionTarget
            momentId="pause_resume"
            active={moment === 'pause_resume'}
            radiusOverride={31}
            accessibilityLabel={paused ? t('mini.resume') : t('mini.pause')}
          >
            <View style={styles.roundBtn}>
              <Ionicons name={paused ? 'play' : 'pause'} size={32} color={colors.pearlWhite} />
            </View>
          </ActionTarget>

          <ActionTarget
            momentId="finish"
            active={moment === 'finish'}
            radiusOverride={14}
            style={styles.sideAction}
            accessibilityLabel={t('recording.finish')}
          >
            <View style={styles.finishBtn}>
              <Ionicons name="checkmark-done" size={18} color={colors.pearlWhite} />
              <Text style={styles.finishText} numberOfLines={1}>{t('recording.finish')}</Text>
            </View>
          </ActionTarget>
        </View>
      </SoftDim>
    </View>
  );
}

// =====================================================================
// Notebook + Mini — mirrors app/mini-caption.tsx (iPad only).
//
// Production is a full-bleed NotebookCanvas page with a small floating,
// draggable panel on top (default position: top-right, dark navy). The
// panel's real controls are Mark / Expand / Pause-Resume — there is no
// Finish here; Finish only exists back on the Recording screen, which is
// exactly where this journey returns to (§4, §6).
// =====================================================================
export function SimulatedNotebookScreen({ moment }: ScreenProps) {
  const t = useT();
  const isCompact = useIsCompactWidth();
  const note = t(DEMO_CONTENT.notebookNoteKey);
  const revealed = useProgressiveWords(note, moment === 'notebook_note', 150);
  // Same session clock the Recording screen shows — the lecture is still
  // running while the student takes notes, and continues from here on return.
  const { demoElapsedSeconds: seconds } = useTutorialTour();

  return (
    <View style={styles.stackScreen}>
      <View style={styles.notebookPage}>
        {/* Ruled page, like the real Notebook canvas. More rules fit the taller
            portrait page; landscape is shorter, so it draws fewer. */}
        {Array.from({ length: isCompact ? 12 : 8 }).map((_, i) => (
          <View key={i} style={styles.ruleLine} />
        ))}
        <Text style={styles.notebookNote}>{revealed}</Text>
      </View>

      {/* Floating pill back to the recording session — decorative here (the
          tutorial's own coach bar drives advancement), matched to the real
          screen's top-left "Recording" affordance so the layout is familiar. */}
      <View style={styles.notebookBackPill}>
        <Ionicons name="chevron-back" size={16} color={colors.deepNavy} />
        <Text style={styles.notebookBackPillText}>{t('mini.recording')}</Text>
      </View>

      {/* The floating Mini panel: captions and recording controls stay
          available while the notebook has the full page. */}
      <Emphasis active style={[styles.miniPanelWrap, isCompact && styles.miniPanelWrapCompact]} radiusOverride={radius.lg}>
        <View style={styles.miniPanel}>
          <View style={styles.miniPanelGrip} />
          <View style={styles.miniPanelTop}>
            <View style={styles.miniRecDot} />
            <Text style={styles.miniTimer}>{formatClock(seconds)}</Text>
          </View>
          <Text style={styles.miniCaption} numberOfLines={2}>{t(DEMO_CONTENT.transcriptLineKey)}</Text>
          <Text style={styles.miniCaptionTranslated} numberOfLines={2}>{t(DEMO_CONTENT.translationLineKey)}</Text>
          <View style={styles.miniControls}>
            <View style={styles.miniControlBtn}>
              <Ionicons name="star-outline" size={15} color={colors.textOnNavy} />
              <Text style={styles.miniControlLabel}>{t('mini.mark')}</Text>
            </View>
            <View style={styles.miniControlBtn}>
              <Ionicons name="scan-outline" size={15} color={colors.textOnNavy} />
              <Text style={styles.miniControlLabel}>{t('mini.expand')}</Text>
            </View>
            <View style={styles.miniControlBtn}>
              <Ionicons name="pause" size={15} color={colors.textOnNavy} />
              <Text style={styles.miniControlLabel}>{t('mini.pause')}</Text>
            </View>
          </View>
        </View>
      </Emphasis>
    </View>
  );
}

// =====================================================================
// Lecture Detail — mirrors app/lecture/[id].tsx. ONE shell, many moments.
// =====================================================================
export function SimulatedLectureDetailScreen({ moment }: ScreenProps) {
  const t = useT();
  const isCompact = useIsCompactWidth();
  // The selected tab comes from the shared demo session — it is whatever the
  // user last TAPPED, never something derived from the current moment. That
  // is the whole point of this screen: press Transcript, see Transcript.
  const { selectedLectureTab, tapLectureTab, demoMarkedAtSeconds, advanceFromTarget } = useTutorialTour();
  const emphasisePlayer = moment === 'playback';
  const emphasiseCloud = moment === 'cloud';
  // Playback starts because Play was pressed, and keeps running afterwards —
  // the recording is playing, so leaving the moment does not silence it.
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setProgress((p) => (p >= 1 ? 0 : p + 0.02)), 120);
    return () => clearInterval(id);
  }, [playing]);

  return (
    <View style={styles.stackScreen}>
      <View style={[styles.stackHeader, !isCompact && styles.stackHeaderWide]}>
        <View style={styles.headerIconBtn}><Ionicons name="chevron-back" size={22} color={colors.textPrimary} /></View>
        <Text style={styles.stackHeaderTitle} numberOfLines={1}>{t(DEMO_CONTENT.lectureTitleKey)}</Text>
        {/* Production pairs the `synced` variant with `status.uploaded` (see
            app/course/[id].tsx) — that is the app's real "this lecture is in
            the cloud" signal, so the tour uses the same pairing. */}
        <Emphasis active={emphasiseCloud} radiusOverride={radius.pill}>
          <StatusPill label={t('status.uploaded')} variant="synced" />
        </Emphasis>
      </View>

      <ScrollView contentContainerStyle={[styles.pageScroll, !isCompact && styles.pageScrollWide]} showsVerticalScrollIndicator={false}>
        <View style={styles.pageContent}>
          <Text style={styles.lectureMeta}>{t(DEMO_CONTENT.lectureMetaKey)}</Text>

          <ActionTarget
            momentId="playback"
            active={emphasisePlayer}
            radiusOverride={radius.xl}
            accessibilityLabel={t('lecture.tab.summary')}
            onPress={() => {
              // Pressing Play starts playback, THEN advances — the user sees
              // the thing they pressed actually happen.
              setPlaying(true);
              advanceFromTarget('playback');
            }}
          >
            <GlassCard>
              <View style={styles.playerRow}>
                <View style={styles.playButton}>
                  <Ionicons name={playing ? 'pause' : 'play'} size={20} color={colors.textOnNavy} />
                </View>
                <Text style={styles.playerTime}>{formatClock(Math.floor(progress * 720))}</Text>
                <ProgressBar value={progress} style={styles.playerProgress} />
                <Text style={styles.playerTime}>12:00</Text>
              </View>
            </GlassCard>
          </ActionTarget>

          <SoftDim active={emphasisePlayer || emphasiseCloud}>
            <View style={styles.reviewTabBar}>
              {LECTURE_TABS.map((tabId: string) => {
                const selected = tabId === selectedLectureTab;
                // Exactly one tab can be the live target, and only on the
                // moment that teaches opening it.
                const emphasised =
                  (moment === 'open_transcript' && tabId === 'transcript') ||
                  (moment === 'open_marked' && tabId === 'marked') ||
                  (moment === 'open_notes' && tabId === 'notes');
                return (
                  <ActionTarget
                    key={tabId}
                    momentId={moment}
                    active={emphasised}
                    style={styles.reviewTabWrap}
                    radiusOverride={radius.sm}
                    accessibilityLabel={t(`lecture.tab.${tabId}`)}
                    onPress={() => tapLectureTab(tabId, moment)}
                  >
                    <View style={[styles.reviewTab, selected && styles.reviewTabActive]}>
                      <Text numberOfLines={1} style={[styles.reviewTabLabel, selected && styles.reviewTabLabelActive]}>
                        {t(`lecture.tab.${tabId}`)}
                      </Text>
                    </View>
                  </ActionTarget>
                );
              })}
            </View>

            {/* Body follows the SELECTED tab — never the moment. */}
            <GlassCard style={styles.reviewBody}>
              {selectedLectureTab === 'summary' ? (
                <View style={styles.summaryStack}>
                  <Text style={styles.reviewText}>{t(DEMO_CONTENT.summaryEnglishKey)}</Text>
                  <Text style={[styles.reviewText, styles.reviewTextTranslated]}>{t(DEMO_CONTENT.summaryTranslatedKey)}</Text>
                </View>
              ) : null}
              {selectedLectureTab === 'transcript' ? (
                <Text style={styles.reviewText}>{t(DEMO_CONTENT.transcriptLineKey)}</Text>
              ) : null}
              {selectedLectureTab === 'marked' ? (
                // The timestamp is the clock the user actually saw when they
                // pressed Mark, and the line is the caption that was on screen.
                <View style={styles.markedRow}>
                  <View style={[styles.markedTimeChip, styles.markedTimeChipFixed]}>
                    <Text style={styles.markedTimeText}>{formatClock(demoMarkedAtSeconds)}</Text>
                  </View>
                  <View style={styles.markedTextWrap}>
                    <Text style={[styles.reviewText, styles.markedText]}>{t(DEMO_CONTENT.transcriptLineKey)}</Text>
                  </View>
                  <View style={styles.markedTrailing}>
                    <Ionicons name="star" size={14} color={colors.textPrimary} />
                  </View>
                </View>
              ) : null}
              {selectedLectureTab === 'notes' ? (
                // This is the same note written in the earlier iPad Notebook
                // moment. The production Notes tab is a lecture-attached
                // preview; it opens NotebookCanvas only after a second tap on
                // iPad, so the tour keeps this as a preview on both devices.
                <View style={styles.notesPreview}>
                  <View style={styles.notesPreviewHeader}>
                    <Ionicons name="create-outline" size={16} color={colors.textPrimary} />
                    <Text style={styles.notesPreviewTitle}>{t('lecture.notes')}</Text>
                  </View>
                  <Text style={styles.reviewText}>{t(DEMO_CONTENT.notebookNoteKey)}</Text>
                  <Text style={styles.notesPreviewHint}>
                    {isPad ? t('lecture.editHint') : t('lecture.notebookIpadOnly')}
                  </Text>
                </View>
              ) : null}
            </GlassCard>
          </SoftDim>
        </View>
      </ScrollView>
    </View>
  );
}

// =====================================================================
// Ready — closing moment
// =====================================================================
export function SimulatedReadyScreen() {
  const t = useT();
  const lines = [
    t('tutorialTour.ready.line1'),
    t('tutorialTour.ready.line2'),
    t('tutorialTour.ready.line3'),
    t('tutorialTour.ready.line4'),
    t('tutorialTour.ready.line5'),
  ];
  if (isPad) lines.push(t('tutorialTour.ready.lineIpad'));

  return (
    <View style={styles.readyStage}>
      <LogoMark size={52} />
      <Text style={styles.readyTitle}>{t('tutorialTour.ready.title')}</Text>
      <Text style={styles.readyBody}>{t('tutorialTour.ready.body')}</Text>
      <View style={styles.readyList}>
        {lines.map((l, i) => (
          <View key={i} style={styles.readyLine}>
            <Ionicons name="checkmark-circle" size={16} color={colors.accent} />
            <Text style={styles.readyLineText}>{l}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pageScroll: { paddingHorizontal: 18, paddingTop: 14, paddingBottom: 20 },
  pageScrollWide: { paddingHorizontal: 28 },
  pageContent: { width: '100%', maxWidth: 1120, alignSelf: 'center', gap: 18 },

  // ---- Home ----
  heroCard: { gap: 6 },
  heroTitle: { marginTop: 12, color: colors.ink, fontSize: 20, fontWeight: '800' },
  heroTitleWide: { fontSize: 22 },
  heroBody: { marginTop: 6, color: colors.textSecondary, fontSize: 13.5, lineHeight: 20 },
  heroActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 18, alignItems: 'center' },
  stepsCard: { gap: 18 },
  step: { flexDirection: 'row', gap: 14 },
  stepNumber: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted },
  stepNumberText: { color: colors.accent, fontSize: 12, fontWeight: '800' },
  stepText: { flex: 1 },
  stepTitle: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  stepBody: { color: colors.textSecondary, fontSize: 12.5, lineHeight: 18, marginTop: 3 },

  // ---- Courses ----
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  // Mirrors app/(tabs)/courses.tsx: a 3-up grid at wide widths, single column
  // when compact — which is what an iPad in portrait actually shows.
  gridItem: { width: '100%', minWidth: 0 },
  gridItemWide: { width: '31.8%', minWidth: 250 },
  ghostCard: {
    minHeight: 196, alignItems: 'center', justifyContent: 'center', gap: 10,
    borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.borderStrong,
    borderRadius: 20, backgroundColor: colors.glass,
  },
  plus: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted },
  ghostLabel: { color: colors.textSecondary, fontSize: 14, fontWeight: '700' },

  // ---- Shared stack-route chrome ----
  stackScreen: { flex: 1 },
  stackHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 12,
    backgroundColor: colors.glass,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  stackHeaderWide: { paddingHorizontal: 20 },
  stackHeaderTitle: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: '800' },
  headerIconBtn: {
    height: 40, minWidth: 40, borderRadius: radius.pill,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  headerSpacer: { width: 40 },

  // ---- Course Detail ----
  courseSummaryRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  courseSummaryText: { flex: 1 },
  courseSummaryName: { color: colors.ink, fontSize: 17, fontWeight: '800' },
  courseSummaryMeta: { color: colors.textTertiary, fontSize: 12, marginTop: 3 },
  startButton: { marginTop: 16 },
  sectionTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  materialsLocalNote: { color: colors.textTertiary, fontSize: 11.5, lineHeight: 16, marginBottom: 10 },
  materialRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  materialIcon: {
    width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surfaceMuted,
  },
  materialText: { flex: 1 },
  materialName: { color: colors.ink, fontSize: 13.5, fontWeight: '700' },
  materialMeta: { color: colors.textTertiary, fontSize: 11.5, marginTop: 2 },
  emptyLectures: { alignItems: 'center', paddingVertical: 24 },
  emptyLecturesText: { color: colors.textTertiary, fontSize: 13 },

  // ---- Recording ----
  // Geometry copied from app/recording.tsx's `header` / `headerCompact`.
  recHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 20, paddingVertical: 13,
    backgroundColor: colors.glass,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
  },
  recHeaderCompact: { gap: 8, paddingHorizontal: 14, flexWrap: 'wrap', rowGap: 8 },
  courseChip: {
    maxWidth: 220, minHeight: 30, flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 10, borderRadius: radius.pill,
    backgroundColor: colors.glassElevated, borderWidth: 1, borderColor: colors.border,
  },
  courseChipCompact: { maxWidth: 130 },
  courseChipText: { color: colors.textSecondary, fontSize: 11.5, fontWeight: '700' },
  headerTimer: {
    flex: 1, textAlign: 'right', color: colors.ink,
    fontSize: 24, fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: 0.3,
  },
  headerTimerCompact: { fontSize: 19 },
  materialTopButton: {
    minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 12, borderRadius: radius.pill,
    backgroundColor: colors.glassElevated, borderWidth: 1, borderColor: colors.border,
  },
  materialTopText: { color: colors.textSecondary, fontSize: 11.5, fontWeight: '700' },
  iconBtnLabelled: {
    height: 44, minWidth: 44, flexDirection: 'row', gap: 5,
    paddingHorizontal: spacing.md, borderRadius: radius.pill,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  iconBtnLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  feedRegion: { flex: 1, paddingHorizontal: 20, justifyContent: 'center', gap: 16 },
  feedRegionWide: { paddingHorizontal: 40 },
  preparing: { color: colors.textSecondary, fontSize: 14, textAlign: 'center' },
  captionBlock: { gap: 10 },
  captionEnglish: { color: colors.ink, fontSize: 20, lineHeight: 28, fontWeight: '700' },
  captionEnglishWide: { fontSize: 26, lineHeight: 36 },
  captionTranslated: { color: colors.textSecondary, fontSize: 15.5, lineHeight: 23, fontWeight: '500' },
  captionTranslatedWide: { fontSize: 19, lineHeight: 27 },
  dictWord: {
    color: colors.accent, fontWeight: '800',
    textDecorationLine: 'underline',
  },
  dictSheet: {
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: spacing.lg, gap: 6,
    alignSelf: 'center', width: '100%', maxWidth: 420,
  },
  dictWordTitle: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  dictDefinition: { color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  markToast: {
    flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'center',
    backgroundColor: colors.deepNavy, paddingHorizontal: spacing.lg, paddingVertical: 10,
    borderRadius: radius.pill,
  },
  markToastText: { color: colors.pearlWhite, fontSize: 12.5, fontWeight: '600' },
  // Geometry copied from app/recording.tsx's `actions` bar.
  controlsRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    paddingHorizontal: 20, paddingTop: 13, paddingBottom: 18, width: '100%',
    backgroundColor: colors.glass,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
  },
  controlsRowCompact: { gap: spacing.sm, paddingHorizontal: 14 },
  sideAction: { flex: 1 },
  utilityBtn: {
    width: 44, height: 44, borderRadius: radius.pill,
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  roundBtn: {
    width: 62, height: 62, borderRadius: 31, backgroundColor: colors.navy,
    alignItems: 'center', justifyContent: 'center',
  },
  finishBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    minHeight: 50, borderRadius: 14, backgroundColor: colors.navy,
  },
  finishText: { color: colors.pearlWhite, fontSize: 14.5, fontWeight: '700' },

  // ---- Notebook + Mini ----
  notebookPage: {
    flex: 1, margin: 16, borderRadius: radius.lg, backgroundColor: colors.surface,
    borderWidth: 1, borderColor: colors.border, paddingTop: 24, paddingHorizontal: 24, overflow: 'hidden',
  },
  ruleLine: { height: 34, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  notebookNote: {
    position: 'absolute', top: 26, left: 26, right: 26,
    color: colors.ink, fontSize: 20, lineHeight: 34, fontWeight: '600',
  },
  notebookBackPill: {
    position: 'absolute', top: 16, left: 16,
    flexDirection: 'row', alignItems: 'center', gap: 4,
    height: 34, paddingHorizontal: 12, borderRadius: radius.pill,
    backgroundColor: 'rgba(255, 255, 255, 0.9)',
  },
  notebookBackPillText: { color: colors.deepNavy, fontSize: 13, fontWeight: '700' },
  // Position and dark navy chrome match the real floating Mini panel
  // (app/mini-caption.tsx), which defaults to the top-right corner.
  miniPanelWrap: { position: 'absolute', right: 16, top: 16, width: 300 },
  miniPanelWrapCompact: { width: 260 },
  miniPanel: {
    backgroundColor: colors.deepNavy, borderRadius: radius.lg,
    padding: 14, gap: 8,
  },
  miniPanelGrip: {
    width: 32, height: 4, borderRadius: 2, alignSelf: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.22)',
  },
  miniPanelTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  miniRecDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.recordingRed },
  miniTimer: { color: colors.textOnNavy, fontSize: 15, fontWeight: '800', fontVariant: ['tabular-nums'] },
  miniCaption: { color: colors.textOnNavy, fontSize: 13, lineHeight: 18, fontWeight: '700' },
  miniCaptionTranslated: { color: colors.textOnNavyMuted, fontSize: 12, lineHeight: 17 },
  miniControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginTop: 2 },
  miniControlBtn: {
    flex: 1, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center', gap: 2,
    backgroundColor: colors.navyElevated,
  },
  miniControlLabel: { color: colors.textOnNavy, fontSize: 10, fontWeight: '700' },

  // ---- Lecture Detail ----
  lectureMeta: { color: colors.textTertiary, fontSize: 12.5 },
  playerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  playButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.navy, alignItems: 'center', justifyContent: 'center' },
  playerTime: { color: colors.textSecondary, fontSize: 11.5, fontWeight: '700', fontVariant: ['tabular-nums'] },
  playerProgress: { flex: 1 },
  reviewTabBar: {
    flexDirection: 'row', gap: 6, padding: 4,
    backgroundColor: colors.surfaceMuted, borderRadius: radius.md,
  },
  reviewTabWrap: { flex: 1 },
  reviewTab: { paddingVertical: 10, borderRadius: radius.sm, alignItems: 'center' },
  reviewTabActive: { backgroundColor: colors.navy },
  reviewTabLabel: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },
  reviewTabLabelActive: { color: colors.pearlWhite },
  reviewBody: { marginTop: 14 },
  notesPreview: { gap: 10 },
  notesPreviewHeader: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  notesPreviewTitle: { color: colors.textPrimary, fontSize: 12, fontWeight: '800', letterSpacing: 0.5 },
  notesPreviewHint: { color: colors.textTertiary, fontSize: 12, lineHeight: 17 },
  reviewText: { color: colors.textPrimary, fontSize: 13.5, lineHeight: 20 },
  reviewTextTranslated: { color: colors.textSecondary },
  summaryStack: { gap: 10 },
  markedRow: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 10 },
  // The timestamp and star retain their footprint. `minWidth: 0` is essential
  // on compact React Native rows: it lets the central text use only remaining
  // width and wrap instead of pushing the trailing icon beyond the card.
  markedTextWrap: { flex: 1, minWidth: 0, flexShrink: 1 },
  markedText: { flexShrink: 1 },
  markedTimeChipFixed: { flexShrink: 0 },
  markedTrailing: { width: 14, minWidth: 14, flexShrink: 0, alignItems: 'center' },
  markedTimeChip: { backgroundColor: colors.surfaceMuted, paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.sm },
  markedTimeText: { color: colors.textPrimary, fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },

  // ---- Ready ----
  readyStage: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl, gap: 10 },
  readyTitle: { marginTop: 8, color: colors.ink, fontSize: 26, fontWeight: '800', textAlign: 'center' },
  readyBody: { color: colors.textSecondary, fontSize: 14, textAlign: 'center' },
  readyList: { marginTop: 14, gap: 10, width: '100%', maxWidth: 340 },
  readyLine: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  readyLineText: { color: colors.textPrimary, fontSize: 13.5, fontWeight: '600', flex: 1 },
});
