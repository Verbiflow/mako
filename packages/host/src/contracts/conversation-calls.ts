import { z } from "zod"

/**
 * The calls that go to the host running a conversation, wherever it runs: another host on this Mac, another device or a
 * cloud Thread's machine. Workspace state, app lifecycle, provider discovery and new conversations stay on the
 * receiving host. One list for every client that routes them: a Mac's host and a browser alike.
 */
const liveTarget = z.object({ kind: z.literal("live"), id: z.string() })
const moveHoldTarget = z.object({ conversation: z.string().optional() })

export const conversationCalls: ReadonlySet<string> = new Set([
  "mako:live-read",
  "mako:live-continue", "mako:live-snapshot", "mako:live-state", "mako:live-prompt", "mako:live-permission",
  "mako:live-mode", "mako:live-cancel", "mako:live-stop-agent", "mako:live-goal", "mako:live-side-question", "mako:live-review", "mako:live-close", "mako:live-prewarm", "mako:live-edit-queued",
  "mako:live-clear-queue", "mako:live-hold-until", "mako:live-sign-in-readiness", "mako:live-sign-in-resume", "mako:live-earlier", "mako:live-bind", "mako:read-live-file",
  "mako:live-merge-fork",
  "mako:live-rewind-preview", "mako:live-rewind", "mako:live-turn-changes", "mako:live-turn-diff", "mako:live-turn-hunks", "mako:live-turn-writers", "mako:live-turn-undo-preview", "mako:live-turn-undo", "mako:live-action", "mako:live-steer-queued",
  "mako:live-action-acknowledge", "mako:live-fork", "mako:live-transfer",
])

/** The conversation a call is aimed at, when it's one that goes to the host running it. */
export function conversationCallId(channel: string, args: unknown[]): string | undefined {
  if (conversationCalls.has(channel)) return z.string().parse(args[0])
  if (channel === "mako:thread-controls" || channel === "mako:thread-stop") {
    const target = liveTarget.safeParse(args[0])
    return target.success ? target.data.id : undefined
  }
  // The host running the Session on screen is the one whose move it would be.
  if (channel === "mako:workspace-move-hold") return moveHoldTarget.safeParse(args[0]).data?.conversation
  return undefined
}
