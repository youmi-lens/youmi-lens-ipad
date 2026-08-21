import { Platform } from 'react-native';

/**
 * Native device idiom — true for actual iPad hardware, regardless of current
 * window size. Unlike a width breakpoint, this stays true in iPad Split View
 * / Slide Over / Stage Manager at a narrow window, which is the whole reason
 * to use it for a capability gate (e.g. Notebook/Pencil) rather than a layout
 * breakpoint: a feature gate must track the hardware, not the current window.
 */
export const isPad = Platform.OS === 'ios' && Platform.isPad;
