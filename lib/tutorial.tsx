/**
 * "Quick Overview" — the original text/card tutorial (formerly the
 * first-run experience). First-run onboarding is now owned entirely by the
 * Simulated Product Tour (lib/tutorialTour.tsx), which is the one thing
 * that auto-shows and the one thing that reads/writes the shared
 * completion flag (see scopedTutorialTourCompletionKey in
 * tutorialTourCore.mjs — the SAME key/prefix V1 used to own, so there is
 * still only ever one "has this user completed first-run onboarding" flag
 * on device).
 *
 * This module is now reachable ONLY via Settings → Help → Quick Overview: it
 * never auto-shows and it never reads or writes any persistence — opening
 * and closing it is purely a presentational, session-local action. Kept
 * around as a fallback/reference overview per the task's own "may remain
 * temporarily" guidance, rather than deleting a working, tested surface.
 */
import { createContext, ReactNode, useCallback, useContext, useMemo, useState } from 'react';

import { isPad } from '@/constants/deviceClass';

import { getTutorialSteps, type TutorialStep } from './tutorialCore.mjs';

type TutorialContextValue = {
  visible: boolean;
  steps: TutorialStep[];
  stepIndex: number;
  openTutorial: () => void;
  closeTutorial: () => void;
  next: () => void;
  back: () => void;
};

const TutorialContext = createContext<TutorialContextValue | null>(null);

export function TutorialProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);

  const steps = useMemo(() => getTutorialSteps(isPad), []);

  const openTutorial = useCallback(() => {
    setStepIndex(0);
    setVisible(true);
  }, []);

  const closeTutorial = useCallback(() => {
    setVisible(false);
  }, []);

  const next = useCallback(() => {
    setStepIndex((index) => Math.min(index + 1, steps.length - 1));
  }, [steps.length]);

  const back = useCallback(() => {
    setStepIndex((index) => Math.max(index - 1, 0));
  }, []);

  const value = useMemo<TutorialContextValue>(
    () => ({ visible, steps, stepIndex, openTutorial, closeTutorial, next, back }),
    [visible, steps, stepIndex, openTutorial, closeTutorial, next, back],
  );

  return <TutorialContext.Provider value={value}>{children}</TutorialContext.Provider>;
}

export function useTutorial(): TutorialContextValue {
  const ctx = useContext(TutorialContext);
  if (!ctx) throw new Error('useTutorial must be used within a TutorialProvider');
  return ctx;
}
