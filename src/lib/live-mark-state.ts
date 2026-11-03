import type { ChildState } from "@mako/host/contracts/agents"
import { harnessLabel } from "@/lib/harness-label"
import type { ThreadStatus } from "@/state/thread-status"

/**
 * Every state one live mark draws, for a Thread and a Fin alike.
 *
 * - `working`: a comet runs round the agent's glyph; `background` is the same comet at half speed and quieter, the turn
 *   done while its Fins or a watcher still run; `starting`, the same comet faint while the agent comes up.
 * - `needs`: a whole ring in caution that breathes, waiting on the person.
 * - `lead`: a dotted ring that drifts, a Fin asking its Apex rather than the person.
 * - `queued`: a still dashed ring, the glyph dimmed.
 * - `open`: a still hairline ring, open in another app with no turn running there.
 * - `failed` and `unread`: a dot cut out of the mark, low right in negative, high right in the text colour.
 * - `idle`: the glyph alone.
 */
export type LiveMarkState = "working" | "background" | "starting" | "needs" | "lead" | "queued" | "open" | "failed" | "unread" | "idle"

const WORDS: Record<LiveMarkState, string> = {
  working: "Working",
  background: "Waiting on background work",
  starting: "Starting",
  needs: "Needs you",
  lead: "Asking its Apex",
  queued: "Queued",
  open: "Open in another app",
  failed: "Failed",
  unread: "Answer ready to review",
  idle: "Idle",
}

export function liveMarkWord(state: LiveMarkState): string {
  return WORDS[state]
}

/** A Thread's status as its mark draws it. */
export function threadMarkState(status: ThreadStatus): LiveMarkState {
  switch (status.kind) {
    case "working":
    case "external-active":
      return "working"
    case "background":
      return "background"
    case "needs-permission":
      return "needs"
    case "failed":
      return "failed"
    case "review":
      return status.unread ? "unread" : "idle"
    case "external-open":
      return "open"
    case "observed":
    case "idle":
      return "idle"
  }
}

/** A Fin's state as its mark draws it. A Fin that ended well is done: its glyph alone, as an idle Thread's. */
export function finMarkState(state: ChildState): LiveMarkState {
  switch (state.kind) {
    case "queued":
      return "queued"
    case "starting":
      return "starting"
    case "working":
      return "working"
    case "blocked":
      return state.on === "lead" ? "lead" : "needs"
    case "idle":
      return "idle"
    case "ended":
      return state.outcome === "failed" ? "failed" : "idle"
  }
}

/** What a Thread's mark says to a screen reader and in its tip. */
export function threadStatusLabel(status: ThreadStatus, harness?: string): string {
  switch (status.kind) {
    case "working":
      return status.detail ?? "Working in Mako"
    case "external-active":
      return `Working in ${status.app ?? "another app"}`
    case "failed":
      return status.detail ?? "Failed"
    case "needs-permission":
      return status.detail ?? "Needs your approval"
    case "background":
      return status.count === 1 ? "Waiting on a background task" : `Waiting on ${status.count} background tasks`
    case "review":
      return status.unread ? "Answer ready to review" : harness ? harnessLabel(harness) : "Done"
    case "external-open":
      return `Open in ${harnessLabel(status.app)}; no running turn reported`
    case "observed":
      return "The session changed; running state is unconfirmed"
    case "idle":
      return harness ? harnessLabel(harness) : "Idle"
  }
}

