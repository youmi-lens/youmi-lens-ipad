import type { ModalProps } from 'react-native';

/**
 * iOS defaults an unspecified React Native Modal to portrait on iPhone.
 * Every app-owned responsive modal uses this explicit contract so presenting
 * it never changes the orientation semantics of the screen underneath.
 */
export const RESPONSIVE_MODAL_ORIENTATIONS: NonNullable<ModalProps['supportedOrientations']> = [
  'portrait',
  'landscape-left',
  'landscape-right',
];
