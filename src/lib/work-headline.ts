import type { ToolKind } from "@mako/sessions/tool-identity"
import type { ToolWorkSummary } from "@/lib/tools"

/**
 * What a stretch of tool calls did, said the way the transcript says everything else, from its counts: "Made 3
 * edits · ran 5 commands · read 12 files". What failed and stayed failed comes first ("2 commands failed (exit
 * 1)"), and the line never says more than three phrases: past that the rest are counted ("9 more steps").
 */
const WORK_PHRASES = [
  { glyph: "edit", count: (work) => work.edits, phrase: (n) => `made ${n === 1 ? "an edit" : `${n} edits`}` },
  { glyph: "shell", count: (work) => work.commands, phrase: (n) => `ran ${n === 1 ? "a command" : `${n} commands`}` },
  { glyph: "read", count: (work) => work.reads, phrase: (n) => `read ${n === 1 ? "a file" : `${n} files`}` },
  { glyph: "search", count: (work) => work.searches, phrase: (n) => `searched ${n === 1 ? "once" : `${n} times`}` },
  { glyph: "skill", count: (work) => work.skills, phrase: (n) => `used ${n === 1 ? "a skill" : `${n} skills`}` },
  { glyph: "agent", count: (work) => work.agents, phrase: (n) => `started ${n === 1 ? "an agent" : `${n} agents`}` },
  { glyph: "todo", count: (work) => work.plans, phrase: (n) => `updated the plan${n === 1 ? "" : ` ${n} times`}` },
  { glyph: "other", count: (work) => work.other, phrase: (n) => `used ${n === 1 ? "another tool" : `${n} other tools`}` },
] satisfies Array<{
  glyph: ToolKind
  count: (work: ToolWorkSummary) => number
  phrase: (count: number) => string
}>

/** The most phrases a headline says. */
const PHRASES = 3

export interface WorkHeadline {
  /** The kinds of work it counts, for the summary's one glyph. */
  kinds: ToolKind[]
  /** What failed and stayed failed, its first phrase: "2 commands failed (exit 1)", "a command and 2 other steps failed". */
  failed?: string
  /** What the calls did, each phrase one kind of work, lower case. */
  did: string[]
  /** All of it as one line, `failed` first. */
  text: string
}

function failedPhrase(work: ToolWorkSummary): string | undefined {
  if (!work.failed) return undefined
  const commands = work.failedCommands
  const others = work.failed - commands
  const exit = work.failedExit === undefined ? "" : ` (exit ${work.failedExit})`
  if (!commands) return `${others === 1 ? "a step" : `${others} steps`} failed`
  const said = commands === 1 ? "a command" : `${commands} commands`
  return others ? `${said} and ${others === 1 ? "another step" : `${others} other steps`} failed` : `${said} failed${exit}`
}

export function workHeadline(work: ToolWorkSummary): WorkHeadline {
  const done = WORK_PHRASES.flatMap((entry) => {
    const count = entry.count(work)
    return count > 0 ? [{ glyph: entry.glyph, count, text: entry.phrase(count) }] : []
  })
  const failed = failedPhrase(work)
  const room = PHRASES - (failed ? 1 : 0)
  const shown = done.length > room ? done.slice(0, room - 1) : done
  const rest = done.slice(shown.length).reduce((total, entry) => total + entry.count, 0)
  const did = [...shown.map((entry) => entry.text), ...(rest > 0 ? [`${rest} more ${rest === 1 ? "step" : "steps"}`] : [])]
  if (!did.length && !failed) did.push(`used ${work.tools} tools`)
  return { kinds: done.map((entry) => entry.glyph), ...(failed && { failed }), did, text: [failed, ...did].filter(Boolean).join(" · ") }
}
