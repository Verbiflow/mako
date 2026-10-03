import { z } from "zod"
import { jsonHooks, markdownCommands } from "../file-authoring.js"

const Handler = z.object({ type: z.string().min(1) }).passthrough().superRefine((value, context) => {
  const field = value.type === "command" ? "command" : value.type === "http" ? "url" : value.type === "prompt" || value.type === "agent" ? "prompt" : null
  if (field && !z.string().trim().min(1).safeParse(value[field]).success)
    context.addIssue({ code: "custom", message: `${value.type} hooks require a nonempty ${field}.` })
})
const Matcher = z.object({ matcher: z.string().optional(), hooks: z.array(Handler) }).passthrough()
const Hooks = z.record(z.string().min(1), z.array(Matcher))

export const claudeHooks = jsonHooks("claude", ".claude/settings.json", (value) => { Hooks.parse(value); return value })
export const claudeCommands = markdownCommands("claude", ".claude/commands")
