import type { HostCallReplay } from "./host-call-policy.js"
import type { ReturnLanded } from "./cloud-threads.js"

/**
 * The Thread's own place as an agent or a shell moves it: Move to the cloud, Bring it back to this Mac and Continue in
 * the cloud, through the host's own moves (`mako:thread-move`, `mako:thread-return`, `mako:thread-continue`), never a
 * second way. One host call, `mako:threads-move`, is every door's: the in-Thread `mako` server's `thread_move`,
 * `mako thread move` and `mako mcp`.
 */

/** Where a Thread goes: `cloud`, as Move to the cloud (or Continue in the cloud, for another device's Thread while it's off); `back`, as Bring it back to this Mac. */
export type ThreadDestination = "cloud" | "back"

export interface ThreadsMoveInput {
  to: ThreadDestination
  /** The person's own call only (a shell outside any Thread): the conversation whose Thread moves. An agent moves its own. */
  conversation?: string
  /** The caller's own key for this move: a repeat with it joins the same move. */
  clientKey: string
}

/** Why a move wasn't taken up, said as the app says it. */
export type ThreadMoveRefusal = "unavailable" | "no-thread" | "not-yours" | "already-there" | "from-the-mac" | "kept-here"

export interface ThreadMoveRefused {
  refused: ThreadMoveRefusal
  why: string
}

/**
 * What a move came to. An agent's call answers at once: `handing-off` (its running turn pauses here and goes on in the
 * cloud), `after-turn` (it moves once the turn ends) or `asked` (the person decides, above the composer). The person's
 * own call answers as the move ended, in the app's words: `moved`, `kept-here`, `back`, `stayed`, `continued`,
 * `failed`, or `unsettled` while the cloud's answer isn't known.
 */
export type ThreadsMoveResult =
  | { outcome: "handing-off"; move: string; next: string }
  | { outcome: "after-turn"; move: string; next: string }
  | { outcome: "asked"; ask: string; next: string }
  | { outcome: "moved"; cloudThread: string; conversation?: string }
  | { outcome: "back"; landed?: ReturnLanded }
  | { outcome: "continued"; cloudThread: string }
  | { outcome: "kept-here" | "stayed" | "failed" | "unsettled"; reason: string }
  | ThreadMoveRefused

/** What the MCP door shows the model of the operation; its input schema is the host call's. */
export interface ThreadToolDefinition {
  channel: "mako:threads-move"
  replay: HostCallReplay
  /** Inputs the MCP door leaves out: an agent moves its own Thread. */
  filled: readonly "conversation"[]
  mcp: {
    name: "thread_move"
    description: string
    fields: Readonly<Record<string, string>>
    annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
  }
}

export const THREAD_MOVE_TOOL: ThreadToolDefinition = {
  channel: "mako:threads-move",
  replay: "replay",
  filled: ["conversation"],
  mcp: {
    name: "thread_move",
    description: [
      "Move this Thread to the cloud, as Move to the cloud does in the app: its worktree, branch, files and every Session in it. Call it when the person asks to continue, move or hand off this work to the cloud, or to keep it going while their Mac is closed or off. Not agents_start: a Fin is new work beside this Thread, which stays on this Mac.",
      "On full access it goes now; on other access Mako asks the person first.",
      "A Thread in its own worktree hands off: keep working, and your turn pauses here and goes on in the cloud. One in the main checkout moves onto its own branch first, once your turn ends.",
      "A cloud Thread is brought back from its Mac (Bring it back to this Mac).",
    ].join(" "),
    fields: {
      to: "cloud. (back is Bring it back to this Mac, from a shell on that Mac.)",
      clientKey: "Your own key for this move: a repeat with it is the same move.",
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
}

/** What a move's answer tells an agent to do next. */
export const AFTER_MOVE = {
  handingOff: "Mako hands this Thread to the cloud now. Keep working as you were: in a few seconds this turn pauses here, and it goes on in the cloud from where it paused, in the same worktree and branch. If your work is done, end your turn; the Thread still moves.",
  afterTurn: "This Thread is in the main checkout, so it moves onto its own branch and then to the cloud once this turn ends. Finish now: make no further edits here, tell the person it continues in the cloud, and end your turn. Its next message runs there.",
  asked: (handsOff: boolean) => `Asked the person: their answer is in a card above the composer. If they allow it, the Thread moves to the cloud${handsOff ? "; if your turn is still running then, it pauses here and goes on there" : ", onto its own branch first, once this turn ends"}. Until then, keep working here.`,
} as const
