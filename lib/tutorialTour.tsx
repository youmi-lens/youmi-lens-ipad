/**
 * Integrated Simulated Tutorial — provider.
 *
 * Owns exactly two things: which TEACHING MOMENT is current, and the
 * ephemeral demo state the simulated screens read. It never watches the real
 * route, never reads/writes real Course/Lecture/Notebook state, and never
 * navigates the real app.
 *
 * `currentScreen` is derived from the current moment, so consecutive moments
 * that share a screen keep that simulated screen mounted (see
 * tutorialTourCore.mjs and TutorialTourOverlay) — the tour reads as one
 * continuous app session rather than a deck of feature cards.
 *
 * Completion persistence reuses the same AsyncStorage key prefix every
 * tutorial generation has used — one "has this user completed first-run
 * onboarding" flag on device.
 */
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { isPad } from '@/constants/deviceClass';

import { useAuth } from './auth';
import { GUEST_STORAGE_SCOPE } from './guest';
import { loadTutorialCompleted, saveTutorialCompleted } from './tutorialPersistence';
import {
  DEMO_MARKED_FALLBACK_SECONDS,
  TOUR_SCREENS,
  getTourMoments,
  isActionMoment,
  isFinalMoment,
  type TourMoment,
} from './tutorialTourCore.mjs';

type TutorialTourContextValue = {
  visible: boolean;
  moments: TourMoment[];
  momentIndex: number;
  /** Increments for every manual replay so all ephemeral screen trees remount. */
  tourRunId: number;
  currentMoment: TourMoment;
  /** Derived from currentMoment — the simulated screen currently on stage. */
  currentScreen: string;
  isPad: boolean;
  canGoBack: boolean;
  isFinal: boolean;
  /**
   * True when the current moment is advanced by tapping its simulated control.
   * The shell hides the generic Next for these, so a moment never offers two
   * competing ways forward.
   */
  isAction: boolean;
  /**
   * Called by a simulated control when the user taps it. Takes the moment the
   * control belongs to so a tap on a stale/foreign target is ignored, and is
   * rate-limited so a rapid double tap cannot skip a moment.
   */
  advanceFromTarget: (momentId: string) => void;
  /**
   * Demo state for the ONE simulated lecture session the whole tour depicts.
   *
   * These live here rather than inside a screen because the journey leaves the
   * Recording screen for Notebook and comes back — and a screen change is a
   * real remount (screens are keyed by screen, deliberately). Local state
   * would restart the clock at zero on the way back, which reads as "a new
   * lecture started". Elapsed time and pause belong to the SESSION, not to
   * whichever screen happens to be on stage.
   *
   * Purely ephemeral: no recorder, no real session, no pendingLectureId, and
   * nothing persisted. Discarded when the tour closes.
   */
  demoElapsedSeconds: number;
  demoPaused: boolean;
  /**
   * Which review tab the simulated Lecture Detail is showing.
   *
   * This changes ONLY when a tab is tapped — never because the tour advanced.
   * Deriving it from the current moment (what this used to do) breaks cause
   * and effect: the user taps Transcript and the tour would move on to a
   * moment whose derived tab was Marked, so they'd see something they did not
   * press. Tapping a tab is the only thing that selects it.
   */
  selectedLectureTab: string;
  /** Selects a review tab because the user tapped it, and advances if that tab
   * was the live target. Both effects come from the one tap. */
  tapLectureTab: (tab: string, momentId: string) => void;
  /**
   * The moment the user actually marked during the simulated recording —
   * captured from the live simulated clock when they tapped Mark. Lecture
   * Detail's Marked tab renders THIS, so "I flagged this in class" and "here
   * it is afterwards" are provably the same event.
   */
  demoMarkedAtSeconds: number;
  reopenTour: () => void;
  skipTour: () => void;
  next: () => void;
  back: () => void;
};

/** Screens that depict the live lecture — the simulated clock runs on these
 * and only these, so it keeps ticking across the Notebook round trip. */
const LIVE_SESSION_SCREENS = new Set<string>([TOUR_SCREENS.RECORDING, TOUR_SCREENS.NOTEBOOK]);

const TutorialTourContext = createContext<TutorialTourContextValue | null>(null);

export function TutorialTourProvider({ children }: { children: ReactNode }) {
  const { session, isGuest, loading, needsUsernameSetup, isResettingPassword } = useAuth();
  const canUseApp = isGuest || (!!session && !needsUsernameSetup && !isResettingPassword);
  const scopeId = session?.user?.id ?? (isGuest ? GUEST_STORAGE_SCOPE : null);

  const moments = useMemo(() => getTourMoments(isPad), []);
  const [visible, setVisible] = useState(false);
  const [momentIndex, setMomentIndex] = useState(0);
  const [tourRunId, setTourRunId] = useState(0);
  const autoCheckedScopeRef = useRef<string | null>(null);

  // ---- Simulated lecture session (ephemeral; see the context type) ----
  const [demoElapsedSeconds, setDemoElapsedSeconds] = useState(0);
  const [demoPaused, setDemoPaused] = useState(false);
  const [selectedLectureTab, setSelectedLectureTab] = useState<string>('summary');
  const [demoMarkedAtSeconds, setDemoMarkedAtSeconds] = useState(DEMO_MARKED_FALLBACK_SECONDS);

  // First-eligible-entry auto-show — the ONLY place that reads the completion
  // flag. Mirrors AuthGate's own canUseApp so this never auto-shows over the
  // username-setup or password-reset flows.
  useEffect(() => {
    if (loading || !canUseApp || !scopeId) return;
    if (autoCheckedScopeRef.current === scopeId) return;
    autoCheckedScopeRef.current = scopeId;
    let cancelled = false;
    void loadTutorialCompleted(scopeId).then((completed) => {
      if (cancelled || completed) return;
      setMomentIndex(0);
      setVisible(true);
    });
    return () => {
      cancelled = true;
    };
  }, [loading, canUseApp, scopeId]);

  const currentMoment = moments[momentIndex] ?? moments[0];
  const currentScreen = currentMoment.screen;

  // The Pause/Resume moment demonstrates itself and then releases, so the
  // journey continues in a running state. Owning this here (rather than in the
  // Recording screen) is what lets the clock below stay honest while paused.
  useEffect(() => {
    if (currentMoment.id !== 'pause_resume') {
      setDemoPaused(false);
      return;
    }
    setDemoPaused(true);
    const id = setTimeout(() => setDemoPaused(false), 1600);
    return () => clearTimeout(id);
  }, [currentMoment.id]);

  // ONE clock for the whole simulated lecture. It advances on the screens that
  // depict the live session — Recording AND Notebook — so walking into the
  // Notebook and back never restarts the lecture. Nothing here touches the
  // real recorder; it is a setInterval over local state.
  useEffect(() => {
    if (!visible || demoPaused || !LIVE_SESSION_SCREENS.has(currentScreen)) return;
    const id = setInterval(() => setDemoElapsedSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [visible, demoPaused, currentScreen]);

  const closeTour = useCallback(() => {
    setVisible(false);
    setMomentIndex(0);
    // A finished tour leaves no simulated session behind — a later replay
    // starts a fresh lecture at 00:00:00.
    setDemoElapsedSeconds(0);
    setDemoPaused(false);
    setSelectedLectureTab('summary');
    setDemoMarkedAtSeconds(DEMO_MARKED_FALLBACK_SECONDS);
    if (scopeId) void saveTutorialCompleted(scopeId);
  }, [scopeId]);

  const reopenTour = useCallback(() => {
    setMomentIndex(0);
    setDemoElapsedSeconds(0);
    setDemoPaused(false);
    setSelectedLectureTab('summary');
    setDemoMarkedAtSeconds(DEMO_MARKED_FALLBACK_SECONDS);
    setTourRunId((runId) => runId + 1);
    setVisible(true);
  }, []);

  // One advancement per moment. The lock is taken on advance and released
  // once the moment actually changes, so two taps landing in the same frame —
  // on the same control, or on a control and Next — can never skip a moment.
  const advanceLockRef = useRef(false);
  useEffect(() => {
    advanceLockRef.current = false;
  }, [momentIndex, visible]);

  const next = useCallback(() => {
    if (advanceLockRef.current) return;
    advanceLockRef.current = true;
    if (isFinalMoment(currentMoment)) {
      closeTour();
      return;
    }
    setMomentIndex((index) => Math.min(index + 1, moments.length - 1));
  }, [currentMoment, moments.length, closeTour]);

  const advanceFromTarget = useCallback(
    (momentId: string) => {
      // A control only speaks for its own moment. This makes a tap on a
      // control that is still mounted from a previous moment a no-op.
      if (momentId !== currentMoment.id) return;
      // Marking is what creates the demo lecture's marked moment, and it is
      // stamped with the clock the user actually saw when they pressed it.
      if (momentId === 'mark_important') setDemoMarkedAtSeconds(demoElapsedSeconds);
      next();
    },
    [currentMoment.id, next, demoElapsedSeconds],
  );

  // A tab is selected because it was TAPPED. The advance is guarded
  // separately, so a tap on a non-target tab would still select it (as the
  // real app does) without moving the tour.
  const tapLectureTab = useCallback(
    (tab: string, momentId: string) => {
      setSelectedLectureTab(tab);
      advanceFromTarget(momentId);
    },
    [advanceFromTarget],
  );

  const back = useCallback(() => {
    setMomentIndex((index) => Math.max(index - 1, 0));
  }, []);

  const value = useMemo<TutorialTourContextValue>(
    () => ({
      visible,
      moments,
      momentIndex,
      tourRunId,
      currentMoment,
      currentScreen,
      isPad,
      canGoBack: momentIndex > 0,
      isFinal: isFinalMoment(currentMoment),
      isAction: isActionMoment(currentMoment),
      advanceFromTarget,
      demoElapsedSeconds,
      demoPaused,
      selectedLectureTab,
      tapLectureTab,
      demoMarkedAtSeconds,
      reopenTour,
      skipTour: closeTour,
      next,
      back,
    }),
    [
      visible, moments, momentIndex, tourRunId, currentMoment, currentScreen, advanceFromTarget,
      demoElapsedSeconds, demoPaused, selectedLectureTab, tapLectureTab,
      demoMarkedAtSeconds, reopenTour, closeTour, next, back,
    ],
  );

  return <TutorialTourContext.Provider value={value}>{children}</TutorialTourContext.Provider>;
}

export function useTutorialTour(): TutorialTourContextValue {
  const ctx = useContext(TutorialTourContext);
  if (!ctx) throw new Error('useTutorialTour must be used within a TutorialTourProvider');
  return ctx;
}
