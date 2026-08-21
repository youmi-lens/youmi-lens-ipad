import { useWindowDimensions } from 'react-native';

import { isPad } from './deviceClass';

/**
 * Below this width the app switches from the iPad split-view/sidebar shell
 * to a single-column phone layout. Matches the threshold `WorkspaceSidebar`
 * already used for collapsing on narrow widths.
 */
export const COMPACT_WIDTH_BREAKPOINT = 900;

/**
 * True when the app should use the single-column phone composition.
 *
 * A phone is ALWAYS compact, in either orientation. A width-only test is not
 * enough: an iPhone 17 Pro Max on its side is 956pt wide, which clears the
 * breakpoint and would hand a phone the iPad sidebar shell — a vertical
 * brand + nav + account rail — on a canvas only 440pt tall. The wide shell is
 * a tablet composition, so it requires a tablet.
 *
 * Width still decides on iPad, which is what keeps Split View / Stage Manager
 * honest: a narrow iPad window correctly falls back to the compact layout.
 */
export function useIsCompactWidth(breakpoint: number = COMPACT_WIDTH_BREAKPOINT): boolean {
  const { width } = useWindowDimensions();
  if (!isPad) return true;
  return width < breakpoint;
}
