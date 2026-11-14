/**
 * A UI test's Electron app and window as the test meant them, whichever Mac runs it.
 *
 * A CI Mac's screen is 1024×768, and a window asked for larger is cut to it as it's made (1024×653 inside). At that
 * width a side surface covers the conversation, as the stage means it to, so what a test looks for there is hidden:
 * the crew card's rows never draw, its marks never move. A window's size set once it exists isn't cut, so
 * `atSize` sets it again.
 *
 * The same Mac asks for reduced motion, which pauses every animation the app gates on it (`visible-animation.ts`):
 * a test that waits for an animation to end, or checks that a mark moves, would wait forever. `withMotion` turns
 * motion on for the test's app, as a person who hasn't asked for less sees it. Call it before `app.whenReady()`.
 */
export function withMotion(app) {
  app.commandLine.appendSwitch("force-prefers-no-reduced-motion")
}

/** `window` at `width` × `height`, past a smaller screen. */
export function atSize(window, width, height) {
  window.setSize(width, height)
  return window
}
