import type { ChildState } from "@mako/host/contracts/agents"
import { harnessLabel } from "@/lib/harness-label"
import type { ThreadStatus } from "@/state/thread-status"

/**
 * Every state one live mark draws, for a Thread and a Fin alike.
 *
 * - `working`: a comet runs round the agent's glyph; `background` is the same comet at half speed and quieter, the turn
 *   done while its Fins or a watcher still run; `starting`, the same comet faint while the agent comes up.
 * - `needs`: the fin in the attention hue over a waterline that breathes, waiting on the person.
 * - `lead`: a dotted ring that drifts, a Fin asking its Apex rather than the person.
 * - `queued`: a still dashed ring, the glyph dimmed.
 * - `open`: a still hairline ring, open in another app with no turn running there.
 * - `failed` and `unread`: a dot cut out of the mark, low right in negative, high right in the text colour.
 * - `idle`: the glyph alone.
 */
/** A Thread wears the two-tone fin of the app icon; a Fin, started by an Apex, the plain fin. */
export type LiveMarkKind = "thread" | "fin"

/** What a working agent is doing, as the gesture its fin makes. */
export type LiveMotion = "thinking" | "writing" | "tool"

/**
 * The gesture for what a working agent says it's doing, read from its step or status line as every surface words it
 * (`readableStep`): a command, a read or a search is a tool; an edit, a write or an answer streaming is writing;
 * anything else, and nothing said, is thinking.
 */
export function motionOf(doing: string | undefined): LiveMotion {
  if (!doing) return "thinking"
  if (/^(Running|Reading|Searching|Finding|Listing|Shell|Script|Read|Search|Find|List|Lints|Fetch|Browse|Tool)\b/i.test(doing)) return "tool"
  if (/^(Editing|Writing|Deleting|Moving|Edit|Write|Delete|Move|Responding|Answering|Composing|Drafting)\b/i.test(doing)) return "writing"
  return "thinking"
}

export type LiveMarkState = "working" | "background" | "starting" | "needs" | "lead" | "queued" | "open" | "failed" | "unread" | "idle"

const WORDS = {
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
} satisfies Record<LiveMarkState, string>

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

/** A Fin's state as its mark draws it. A Fin that ended well is done: its glyph alone, as an idle Thread's, unless it leaves the person a decision. */
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
      return state.outcome === "failed" || state.unfinished ? "failed" : state.decision?.on === "person" ? "needs" : "idle"
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

