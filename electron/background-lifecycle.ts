import type { HostLifecycle } from "./host-lifecycle.js"

export interface BackgroundLifecycle {
  lifecycle: HostLifecycle
  /** Whether a quit Electron starts should leave the host running in the background instead. */
  keepInBackground(): boolean
  hide(): void
}

/**
 * Electron's own quit events, while Electron runs the host: the last window
 * closing, Cmd+Q, the system logging out. before-quit may still be cancelled
 * by a window, so it only decides whether to stay in the background; only
 * will-quit stops the host, through its one lifecycle. A stop the host started
 * itself ends the process directly and passes through both untouched.
 */
export function backgroundLifecycle({ lifecycle, keepInBackground, hide }: BackgroundLifecycle) {
  return {
    beforeQuit(event: { preventDefault(): void }): void {
      if (lifecycle.running() && keepInBackground()) {
        event.preventDefault()
        hide()
      }
    },
    willQuit(event: { preventDefault(): void }): void {
      if (lifecycle.state().kind === "stopped") return
      event.preventDefault()
      void lifecycle.stop({ kind: "desktop" })
    },
  }
}
