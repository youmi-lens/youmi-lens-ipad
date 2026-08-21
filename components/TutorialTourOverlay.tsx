import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Modal } from 'react-native';

import { TutorialAppShell } from '@/components/tutorialTour/TutorialAppShell';
import {
  SimulatedCourseDetailScreen,
  SimulatedCoursesScreen,
  SimulatedHomeScreen,
  SimulatedLectureDetailScreen,
  SimulatedNotebookScreen,
  SimulatedReadyScreen,
  SimulatedRecordingScreen,
} from '@/components/tutorialTour/simulatedScreens';
import { motion, useReduceMotion } from '@/constants/motion';
import { RESPONSIVE_MODAL_ORIENTATIONS } from '@/constants/modal';
import { useT } from '@/lib/i18n';
import { useTutorialTour } from '@/lib/tutorialTour';
import { TOUR_SCREENS } from '@/lib/tutorialTourCore.mjs';

/**
 * Root of the integrated simulated tutorial.
 *
 * The critical detail is the `key` on ScreenTransition: it is keyed by
 * SCREEN, never by teaching moment. Consecutive moments that share a screen
 * therefore reconcile into the SAME mounted screen component — the Recording
 * screen's simulated timer keeps ticking across start → captions →
 * translation → dictionary → mark → pause → finish, and Lecture Detail keeps
 * its shell while only the focused tab changes. A screen change is the only
 * thing that remounts and cross-fades, which is what makes the tour read as
 * one continuous app session (asserted in scripts/tutorial-tour.test.mjs).
 */
export function TutorialTourOverlay() {
  const t = useT();
  const {
    visible,
    moments,
    momentIndex,
    tourRunId,
    currentMoment,
    currentScreen,
    canGoBack,
    isFinal,
    isAction,
    skipTour,
    next,
    back,
  } = useTutorialTour();

  if (!visible) return null;

  return (
    <Modal
      visible
      animationType="fade"
      onRequestClose={skipTour}
      statusBarTranslucent
      supportedOrientations={RESPONSIVE_MODAL_ORIENTATIONS}
    >
      <TutorialAppShell
        key={tourRunId}
        activeTab={currentMoment.tab}
        progress={momentIndex + 1}
        total={moments.length}
        label={t(currentMoment.labelKey)}
        canGoBack={canGoBack}
        isFinal={isFinal}
        isAction={isAction}
        onNext={next}
        onBack={back}
        onSkip={skipTour}
      >
        <ScreenTransition key={currentScreen}>
          <ScreenSwitch screen={currentScreen} moment={currentMoment.id} />
        </ScreenTransition>
      </TutorialAppShell>
    </Modal>
  );
}

function ScreenSwitch({ screen, moment }: { screen: string; moment: string }) {
  switch (screen) {
    case TOUR_SCREENS.HOME:
      return <SimulatedHomeScreen moment={moment} />;
    case TOUR_SCREENS.COURSES:
      return <SimulatedCoursesScreen moment={moment} />;
    case TOUR_SCREENS.COURSE_DETAIL:
      return <SimulatedCourseDetailScreen moment={moment} />;
    case TOUR_SCREENS.RECORDING:
      return <SimulatedRecordingScreen moment={moment} />;
    case TOUR_SCREENS.NOTEBOOK:
      return <SimulatedNotebookScreen moment={moment} />;
    case TOUR_SCREENS.LECTURE_DETAIL:
      return <SimulatedLectureDetailScreen moment={moment} />;
    case TOUR_SCREENS.READY:
      return <SimulatedReadyScreen />;
    default:
      return null;
  }
}

/** Cross-fade + small settle on SCREEN change only. Reduced-Motion-safe:
 * the screen is fully visible immediately, never gated on an animation. */
function ScreenTransition({ children }: { children: ReactNode }) {
  const reduceMotion = useReduceMotion();
  const progress = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;

  useEffect(() => {
    if (reduceMotion) {
      progress.setValue(1);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: motion.tutorialSpotlightDuration,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (!finished) progress.setValue(1);
    });
    return () => {
      animation.stop();
      progress.setValue(1);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const animatedStyle = reduceMotion
    ? null
    : {
        transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
      };

  return <Animated.View style={[{ flex: 1, minHeight: 0 }, animatedStyle]}>{children}</Animated.View>;
}

export default TutorialTourOverlay;
