import { z } from "zod"
import { conversationCheckpoint } from "../conversation-checkpoint.js"

/**
 * A Claude Code session's checkpoint over its conversation lines alone
 * (`conversationCheckpoint`). Claude Code appends bookkeeping after a turn
 * and as its process exits (`cost-state`, `last-prompt`, `custom-title`,
 * `atis-latch`); a line that begins `{"type":"<bookkeeping>"` at the end of
 * the transcript is left out. Any other line is the conversation's (its
 * `user`, `assistant`, `system` and `attachment` records), and so is an
 * explicit `last-prompt`, which a rewind writes to say where the
 * conversation goes on from.
 */
export const claudeSessionCheckpoint = conversationCheckpoint("c1:", bookkeeping)

/** Record types Claude Code writes beside the conversation (`CLAUDE_RECORD_TYPES` less what history draws). */
const BOOKKEEPING = new Set([
  "last-prompt", "cost-state", "custom-title", "ai-title", "summary", "atis-latch", "queue-operation", "tag",
  "agent-name", "agent-color", "agent-setting", "pr-link", "mode", "permission-mode", "isolation-latch", "dev-mods",
  "memory-mode", "worktree-state", "observer-ref", "file-history-snapshot", "file-history-delta", "attribution-snapshot",
  "bridge-session", "history-suppression", "artifact-comment-monitor", "artifact-autoreact-ledger", "tools-used",
])
const LEADING_TYPE = /^\{"type":"([^"]+)"/

/** A `last-prompt` a rewind writes: the conversation goes on from the message it names. */
const ExplicitLeafSchema = z.object({ type: z.literal("last-prompt"), explicit: z.literal(true) })

function bookkeeping(line: string): boolean {
  const type = LEADING_TYPE.exec(line)?.[1]
  if (!type || !BOOKKEEPING.has(type)) return false
  if (type !== "last-prompt") return true
  try {
    return !ExplicitLeafSchema.safeParse(JSON.parse(line)).success
  } catch {
    return false
  }
}
