import { z } from "zod"
import { hostLog } from "../base/host-log.js"
import type { JsonObject } from "../contracts/json.js"
import { routeShellCall, type CallThread } from "../contracts/native-calls.js"

/**
 * Mako's answer to a harness's command hook that posts its tool call to the
 * conversation server (`/calls/<harness>/<pre|post>`), for a harness whose
 * hooks run commands rather than asking Mako in its own process. Each hook
 * event is Claude Code's shape, which these harnesses share: `tool_name`,
 * `tool_input`, `cwd`.
 */
export const GATED_HARNESSES = ["devin", "codex"] as const
export type GatedHarness = (typeof GATED_HARNESSES)[number]

const HookEvent = z.object({
  tool_name: z.string().optional(),
  tool_input: z.object({ command: z.union([z.string(), z.array(z.string())]).optional(), workdir: z.string().optional() }).loose().optional(),
  cwd: z.string().optional(),
}).loose()

/** A shell tool's command as one line: Codex can pass argv (`["bash", "-lc", "…"]`). */
function commandLine(command: string | string[] | undefined): string | undefined {
  if (command === undefined || typeof command === "string") return command
  const script = command.findIndex((word) => /^-[a-z]*c$/.test(word))
  return script >= 0 && command[script + 1] !== undefined ? command[script + 1] : command.join(" ")
}

/** What a harness's hook prints for one call: a deny before it runs, a note after it ran, or nothing. */
export function callGateAnswer(harness: GatedHarness, event: "pre" | "post", body: unknown, thread: CallThread, conversation: string): JsonObject {
  const call = HookEvent.safeParse(body)
  const command = call.success ? commandLine(call.data.tool_input?.command) : undefined
  if (!call.success || !command) return {}
  const cwd = call.data.tool_input?.workdir ?? call.data.cwd ?? thread.folder
  const route = routeShellCall(thread, { command, ...cwd && { cwd } })
  const fields = { harness, tool: call.data.tool_name, conversation }
  if (route.kind === "deny" && event === "pre") {
    hostLog("routing", "native call denied", { ...fields, family: route.family, rule: route.rule })
    return harness === "devin"
      ? { decision: "block", reason: route.message }
      : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: route.message } }
  }
  if (route.kind === "warn" && event === "post") {
    hostLog("routing", "native call warned", { ...fields, family: route.family, rule: route.rule })
    return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: route.message } }
  }
  return {}
}
