import { BriefSchema } from "@mako/host/contracts/agents"
import {
  AutomationGateSchema,
  AutomationLimitsSchema,
  AutomationResultSchema,
  AutomationStartSchema,
  AutomationThreadSchema,
  AutomationTriggerSchema,
  type AutomationDiffEntry,
  type AutomationDiffField,
} from "@mako/host/contracts/automations"
import type { JsonValue } from "@mako/host/contracts/json"
import { z } from "zod"
import { briefText, limitFacts, RESULT_WORDS, startFacts, triggerWaits, triggerWithCondition } from "@/lib/automation-words"

/**
 * A proposal's diff (`automationDiff`) as a person reads it: the prompt line by line, each trigger as its sentence
 * kept, added or removed, and the start settings, limits, gate, thread and result as the facts that change, before
 * and after. A side that doesn't parse is shown as written, never dropped.
 */

export type DiffMark = "same" | "add" | "remove"
export interface DiffLine {
  mark: DiffMark
  text: string
}

export interface FactChange {
  label: string
  before?: string
  after?: string
}

export type ReadableDiff =
  | { field: "name"; before?: string; after?: string }
  | { field: "prompt"; lines: DiffLine[] }
  | { field: "triggers"; items: Array<DiffLine & { waits?: string }> }
  | { field: Exclude<AutomationDiffField, "name" | "prompt" | "triggers">; facts: FactChange[] }

export const DIFF_FIELD_WORDS = {
  name: "Name",
  prompt: "Prompt",
  triggers: "Triggers",
  start: "Starts with",
  limits: "Limits",
  gate: "Gate",
  thread: "Thread",
  result: "Result",
} satisfies Record<AutomationDiffField, string>

/** Lines of `before` and `after`, each kept, removed or added, by their longest common run. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before ? before.split("\n") : []
  const b = after ? after.split("\n") : []
  // Prompts are short: the plain table is a few thousand cells at most.
  const table: number[][] = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ mark: "same", text: a[i]! })
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) lines.push({ mark: "remove", text: a[i++]! })
    else lines.push({ mark: "add", text: b[j++]! })
  }
  while (i < a.length) lines.push({ mark: "remove", text: a[i++]! })
  while (j < b.length) lines.push({ mark: "add", text: b[j++]! })
  return lines
}

const TEXT = z.string()

function shown(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined
  const text = TEXT.safeParse(value)
  return text.success ? text.data : JSON.stringify(value)
}

function promptText(value: JsonValue | undefined): string {
  if (value === undefined) return ""
  const parsed = BriefSchema.safeParse(value)
  return parsed.success ? briefText(parsed.data) : (shown(value) ?? "")
}

function triggerTexts(value: JsonValue | undefined): Array<{ text: string; waits?: string }> {
  if (!Array.isArray(value)) return value === undefined ? [] : [{ text: shown(value) ?? "" }]
  return value.map((each) => {
    const parsed = AutomationTriggerSchema.safeParse(each)
    return parsed.success ? { text: triggerWithCondition(parsed.data), waits: parsed.data.kind === "unsupported" ? triggerWaits(parsed.data) : undefined } : { text: shown(each) ?? "" }
  })
}

function factsOf(field: Exclude<AutomationDiffField, "name" | "prompt" | "triggers">, value: JsonValue | undefined, harnessLabel: (id: string) => string): Array<[string, string]> {
  if (value === undefined) return []
  switch (field) {
    case "start": {
      const parsed = AutomationStartSchema.safeParse(value)
      return parsed.success ? startFacts(parsed.data, harnessLabel) : [["Start", shown(value) ?? ""]]
    }
    case "limits": {
      const parsed = AutomationLimitsSchema.safeParse(value)
      return parsed.success ? limitFacts(parsed.data) : [["Limits", shown(value) ?? ""]]
    }
    case "gate": {
      const parsed = AutomationGateSchema.safeParse(value)
      return parsed.success ? [["Command", parsed.data.command], ["Gives up after", `${parsed.data.timeoutS} s`]] : [["Gate", shown(value) ?? ""]]
    }
    case "thread": {
      const parsed = AutomationThreadSchema.safeParse(value)
      return [["Thread", parsed.success ? (parsed.data === "standing" ? "One standing Thread" : "A new Thread each run") : (shown(value) ?? "")]]
    }
    case "result": {
      const parsed = AutomationResultSchema.safeParse(value)
      return [["Result", parsed.success ? RESULT_WORDS[parsed.data].label : (shown(value) ?? "")]]
    }
  }
}

/** The facts that differ between two sides, in the order the first side, then the second, names them. */
function factChanges(before: Array<[string, string]>, after: Array<[string, string]>): FactChange[] {
  const labels = [...new Set([...before.map(([label]) => label), ...after.map(([label]) => label)])]
  const was = new Map(before)
  const now = new Map(after)
  return labels.flatMap((label) => {
    const a = was.get(label)
    const b = now.get(label)
    if (a === b) return []
    return [{ label, ...(a !== undefined && { before: a }), ...(b !== undefined && { after: b }) }]
  })
}

/** Each changed part of a proposal, readable. */
export function readableDiff(entries: readonly AutomationDiffEntry[], harnessLabel: (id: string) => string): ReadableDiff[] {
  return entries.map((entry): ReadableDiff => {
    switch (entry.field) {
      case "name":
        return { field: "name", ...(entry.before !== undefined && { before: shown(entry.before) }), ...(entry.after !== undefined && { after: shown(entry.after) }) }
      case "prompt":
        return { field: "prompt", lines: lineDiff(promptText(entry.before), promptText(entry.after)) }
      case "triggers": {
        const before = triggerTexts(entry.before)
        const after = triggerTexts(entry.after)
        const kept = new Set(before.map((each) => each.text).filter((text) => after.some((other) => other.text === text)))
        return {
          field: "triggers",
          items: [
            ...before.filter((each) => !kept.has(each.text)).map((each) => ({ mark: "remove" as const, ...each })),
            ...after.map((each) => ({ mark: kept.has(each.text) ? ("same" as const) : ("add" as const), ...each })),
          ],
        }
      }
      default: {
        const field = entry.field
        return { field, facts: factChanges(factsOf(field, entry.before, harnessLabel), factsOf(field, entry.after, harnessLabel)) }
      }
    }
  })
}
