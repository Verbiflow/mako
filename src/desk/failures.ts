import { desktop } from "@/state/desktop"
import { diagnostics } from "@/state/diagnostics"

/**
 * Errors the error boundary never sees.
 *
 * A boundary only catches what throws during render. Everything else — a
 * listener that throws, a promise nobody caught, a failed dynamic import — goes
 * to `window.onerror` and vanishes into a console. Those are the ones that
 * leave the app subtly wrong rather than obviously broken, which makes them
 * the ones most worth writing down.
 *
 * Recorded, not surfaced. The app is still standing after these, and a toast
 * per unhandled rejection would be noise on top of a bug.
 */

/** One report per distinct message, so a failure in a loop cannot fill the disk. */
const seen = new Set<string>()
const LIMIT = 25

interface RejectionReport {
  message: string
  stack?: string
}

function parseRejection(reason: PromiseRejectionEvent["reason"]): RejectionReport {
  if (reason instanceof Error) return { message: reason.message, stack: reason.stack }
  const boxed = Object(reason)
  if (boxed !== reason && boxed.constructor === String) return { message: String(reason) }
  return { message: "Unhandled rejection" }
}

function report(
  kind: "renderer-error" | "renderer-rejection",
  message: string,
  stack?: string,
  source?: string
) {
  if (!desktop.available() || !message) return
  const key = `${kind}:${message}:${source ?? ""}`
  if (seen.has(key) || seen.size >= LIMIT) return
  seen.add(key)
  void diagnostics
    .report(kind, { message, stack, source })
    .catch(() => {
      // Reporting a failure must never itself fail loudly.
    })
}

export function watchForFailures() {
  window.addEventListener("error", (event) => {
    // The browser deferring resize notifications to the next frame, as virtualized lists do while they measure; nothing failed.
    if (event.message === "ResizeObserver loop completed with undelivered notifications.") return
    const where = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined
    report("renderer-error", event.message, event.error?.stack, where)
  })

  window.addEventListener("unhandledrejection", (event) => {
    const failure = parseRejection(event.reason)
    report("renderer-rejection", failure.message, failure.stack)
  })
}
