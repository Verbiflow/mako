import { z } from "zod"
import { conversationCheckpoint } from "../conversation-checkpoint.js"

/**
 * A Grok session's checkpoint over its conversation lines alone
 * (`conversationCheckpoint`). Grok 1.0.46 writes its Stop and SessionEnd
 * hooks' runs to `updates.jsonl` after the turn's `turn_completed`, the
 * SessionEnd one as Mako closes its process for a switch; the history
 * reader ignores `hook_execution` updates, so one at the end of the record
 * is left out.
 */
export const grokSessionCheckpoint = conversationCheckpoint("g1:", (line) => {
  if (!line.includes(`"sessionUpdate":"hook_execution"`)) return false
  try {
    return HookRunSchema.safeParse(JSON.parse(line)).success
  } catch {
    return false
  }
})

const HookRunSchema = z.object({ params: z.object({ update: z.object({ sessionUpdate: z.literal("hook_execution") }) }) })
