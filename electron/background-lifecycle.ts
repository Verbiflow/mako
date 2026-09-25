export interface BackgroundLifecycle {
  hasActiveWork(): boolean
  isRestarting(): boolean
  hide(): void
  cleanup(): void | Promise<void>
  quit(): void
  failed(error: Error): void
}

/** before-quit may still be cancelled by a window; only will-quit owns teardown. */
export function backgroundLifecycle(lifecycle: BackgroundLifecycle) {
  let finishing = false
  let finished = false
  return {
    beforeQuit(event: { preventDefault(): void }): void {
      if (!finishing && !lifecycle.isRestarting() && lifecycle.hasActiveWork()) {
        event.preventDefault()
        lifecycle.hide()
      }
    },
    willQuit(event: { preventDefault(): void }): void {
      if (finished) return
      event.preventDefault()
      if (finishing) return
      finishing = true
      void Promise.resolve().then(() => lifecycle.cleanup()).then(() => {
        finished = true
        // Electron must finish unwinding the prevented will-quit event first.
        // A microtask-only cleanup can otherwise make its next quit a no-op.
        setImmediate(() => lifecycle.quit())
      }, error => lifecycle.failed(error instanceof Error ? error : new Error(String(error))))
    },
  }
}
