/**
 * A UI test's Electron app and window as the test meant them, whichever Mac runs it.
 *
 * A CI Mac's screen is 1024×768, and a window asked for larger is cut to it as it's made (1024×653 inside). At that
 * width a side surface covers the conversation, as the stage means it to, so what a test looks for there is hidden:
 * the Shiver card's rows never draw, its marks never move. A window's size set once it exists isn't cut, so
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

/**
 * Loads `url` in a UI test's window as a page of its own: through about:blank, and once more if its renderer dies as
 * it loads, which it says.
 *
 * Chromium keeps a same-site page's renderer for the next page, and on the Mac runner that renderer died (SIGTRAP) as
 * a fixture page left one for another a moment after it loaded: shiver-card-ui's browser-to-phone step in 18 runs of 500
 * (#702), and its phone-to-quiet-scene step on main on 2026-11-16. The load then fails ERR_FAILED (-2), and whatever
 * the test asks of the page waits on a frame that's gone ("Render frame was disposed before WebFrameMain could be
 * accessed"). Through about:blank it died in none of 100, and a load whose renderer died anyway goes again on a
 * fresh one. A second death fails the test: that is no longer a one-off.
 *
 * `MAKO_TEST_KILL_LOADS` (the numbers of this window's loads, from 1, comma-separated) kills the renderer 20 ms into
 * each such load, to show the path: the probe that found it, as a switch.
 */
export async function navigate(window, url) {
  const contents = window.webContents
  const count = (loads.get(window) ?? 0) + 1
  loads.set(window, count)
  const kill = (process.env.MAKO_TEST_KILL_LOADS ?? "").split(",").map(Number).includes(count)
  for (let attempt = 1; ; attempt += 1) {
    let gone
    const died = (_event, details) => { gone = details }
    contents.on("render-process-gone", died)
    try {
      await window.loadURL("about:blank")
      const loading = window.loadURL(url)
      if (kill && attempt === 1) setTimeout(() => contents.isDestroyed() || contents.forcefullyCrashRenderer(), 20)
      await loading
      return
    } catch (error) {
      // The load fails before Chromium says its renderer went: give that word a moment to come.
      if (error?.code === "ERR_FAILED") for (const end = Date.now() + 3_000; !gone && !contents.isCrashed() && Date.now() < end; ) await new Promise((done) => setTimeout(done, 25))
      if (attempt > 1 || !(contents.isCrashed() || gone)) throw error
      console.warn(`navigate: the renderer went away (${gone ? `${gone.reason}, exit ${gone.exitCode}` : "crashed"}) as ${url} loaded; loading it again`)
    } finally {
      contents.off("render-process-gone", died)
    }
  }
}

/** Each window's loads so far, for `MAKO_TEST_KILL_LOADS`. */
const loads = new WeakMap()
