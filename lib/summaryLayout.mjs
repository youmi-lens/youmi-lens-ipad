/**
 * Summary is long-form reading content. Keep this contract independent of
 * viewport width so landscape iPads never switch back to a two-column grid.
 */
export const SUMMARY_STACK_STYLE = Object.freeze({
  flexDirection: 'column',
  alignItems: 'stretch',
  width: '100%',
});

/** Bound the existing page scroller so long cards scroll instead of clipping. */
export const SUMMARY_PAGE_SCROLL_STYLE = Object.freeze({
  flex: 1,
});

/** Minimum height stabilizes loading → ready without clipping long content. */
export const SUMMARY_CARD_STYLE = Object.freeze({
  width: '100%',
  minHeight: 112,
});
