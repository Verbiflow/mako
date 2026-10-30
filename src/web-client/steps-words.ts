import type { ToolKind } from "@mako/sessions/tool-identity"
import { liveVerb } from "@/state/agent-activity"
import { toolLabel, toolTarget } from "@/lib/tools"
import type { ToolCall } from "@/extend/slots"

/** What a finished step did, said as the line says it: "ran", "read", "edited". */
const DONE_VERBS = {
  shell: "Ran",
  "shell-output": "Read the output of",
  "shell-input": "Typed into",
  "shell-stop": "Stopped",
  read: "Read",
  edit: "Edited",
  write: "Wrote",
  delete: "Deleted",
  move: "Moved",
  list: "Listed",
  search: "Searched",
  find: "Found",
  "web-fetch": "Fetched",
  "web-search": "Searched the web for",
  code: "Ran a script",
  computer: "Used",
  agent: "Ran an agent:",
  "agent-message": "Messaged an agent",
  "agent-wait": "Waited for an agent",
  agents: "Checked agents",
  todo: "Updated the plan",
  plan: "Planned",
  "plan-exit": "Proposed a plan",
  question: "Asked",
  review: "Reviewed",
  "tool-search": "Found a tool",
  skill: "Used",
  mcp: "Used",
  mode: "Switched mode",
  think: "Thought",
  image: "Made an image",
  wait: "Waited",
  other: "Used",
} as const satisfies Record<ToolKind, string>

/** Kinds whose verb says nothing of the tool, so its label follows the verb ("Used Linear: create issue"). */
const NAMED_BY_LABEL: ReadonlySet<ToolKind> = new Set(["mcp", "other", "computer", "skill"])

/** One step in the line's words, its verb in the tense of whether it's still running. */
export function stepWords(call: ToolCall, running: boolean): string {
  const kind = call.tool.kind
  const verb = running ? liveVerb(kind) : DONE_VERBS[kind]
  const label = NAMED_BY_LABEL.has(kind) ? toolLabel(call.tool) : ""
  const target = toolTarget(call.tool)
  const said = [verb, label, target].filter(Boolean).join(" ")
  return said.charAt(0).toLowerCase() + said.slice(1)
}

/** A run of steps as the phone's one line says it: how many, and the newest one. */
export interface StepsLine {
  count: string
  newest: string
  /** The newest step is running now: the line says it in the present tense and sweeps. */
  running: boolean
  /** The newest step failed: the line is red. */
  failed: boolean
}

/**
 * "3 steps · ran node test/payments.mjs": the run's count, and what its newest step did, in the present tense while it
 * runs ("running npm test"). One step is only its words ("Ran ls test"): a count of one says nothing. A run whose newest
 * step failed says so in red; one stopped or cut off says it ended there.
 */
export function stepsLine(calls: readonly ToolCall[], live: boolean): StepsLine {
  const newest = calls.at(-1)
  const running = Boolean(live && newest?.pending)
  const count = `${calls.length} ${calls.length === 1 ? "step" : "steps"}`
  if (!newest) return { count, newest: live ? "starting" : "", running: false, failed: false }
  const failed = Boolean(newest.isError) && !newest.pending
  const ended = newest.isCanceled ? " · stopped" : newest.isCutOff ? " · cut off" : ""
  const words = `${stepWords(newest, running)}${ended}`
  if (calls.length === 1) return { count: "", newest: words.charAt(0).toUpperCase() + words.slice(1), running, failed }
  return { count, newest: words, running, failed }
}

/** A step that began this recently animates in when it's drawn; older ones are simply there. */
export const FRESH_STEP_MS = 3_000

export function freshStep(call: Pick<ToolCall, "startedAt">, now: number): boolean {
  return call.startedAt !== undefined && now - call.startedAt < FRESH_STEP_MS
}
