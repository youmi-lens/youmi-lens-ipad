/** Pure transition decisions for the Notebook floating toolbar. */
export function shouldStartToolbarTransition(currentCollapsed, requestedCollapsed) {
  return Boolean(currentCollapsed) !== Boolean(requestedCollapsed);
}

export function reduceToolbarCollapsed(currentCollapsed, requestedCollapsed) {
  return shouldStartToolbarTransition(currentCollapsed, requestedCollapsed)
    ? Boolean(requestedCollapsed)
    : Boolean(currentCollapsed);
}
