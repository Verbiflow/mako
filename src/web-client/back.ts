let drawn = false

/**
 * A Back the browser drew itself (Safari's own swipe back in a tab) shouldn't be drawn twice: a `popstate` that says so
 * (`hasUAVisualTransition`) pops the screen at once.
 */
export function heardPop(event: PopStateEvent): void {
  drawn = "hasUAVisualTransition" in event && event.hasUAVisualTransition === true
}

/** Whether the last Back was drawn by the browser; asking settles it. */
export function browserDrewBack(): boolean {
  const was = drawn
  drawn = false
  return was
}
