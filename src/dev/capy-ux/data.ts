import { childGroup, childLine, childStateOf, orderedChildren, rollup, type ChildGroup, type Rollup } from "@mako/host/contracts/children"
import type { ChildState } from "@mako/host/contracts/agents"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { apexFins, APEX_TITLE } from "../mock-apex-thread"

/** Every state one live mark draws, for a Thread and a Fin alike. */
export type MarkState = "working" | "background" | "starting" | "needs" | "lead" | "queued" | "failed" | "unread" | "done" | "idle"

export function finMark(state: ChildState): MarkState {
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
      return "done"
    case "ended":
      return state.outcome === "failed" ? "failed" : "done"
  }
}

/** A pip's group: a Fin asking its Apex is at work for the person, but drawn hollow so the crew shows the conversation. */
export function pipGroup(state: ChildState): ChildGroup | "lead" {
  return state.kind === "blocked" && state.on === "lead" ? "lead" : childGroup(state)
}

export interface Fin {
  agent: NativeAgent
  name: string
  state: ChildState
  group: ChildGroup
  mark: MarkState
  line?: string
}

export function finsOf(agents: readonly NativeAgent[]): Fin[] {
  return orderedChildren([...agents]).map((agent) => {
    const state = childStateOf(agent)
    return { agent, name: agent.child?.name ?? agent.title, state, group: childGroup(state), mark: finMark(state), line: childLine(state) }
  })
}

export const FIXTURE_FINS = apexFins()
export function crewRollup(agents: readonly NativeAgent[]): Rollup {
  return rollup(orderedChildren([...agents]))
}

export interface RailThread {
  id: string
  title: string
  harness: string
  /** Earlier harnesses this Thread ran on, oldest first: its own transcript shows each hand-off. */
  earlier?: string[]
  mark: MarkState
  /** What the agent is doing now, or what it asks. */
  line?: string
  age: string
  project: string
  branch?: string
  pinned?: boolean
  apex?: boolean
  pr?: { number: number; state: "open" | "checks" | "merged" | "draft" }
}

export const APEX_ID = "mobile-polish"

export const THREADS: RailThread[] = [
  { id: "release", title: "Cut the 0.170 release", harness: "cursor", mark: "idle", age: "2h", project: "mako", pinned: true, branch: "release/0.170", pr: { number: 321, state: "draft" } },
  { id: APEX_ID, title: APEX_TITLE, harness: "claude", mark: "working", line: "Reading Sheet motion's report", age: "52m", project: "mako", apex: true, branch: "mobile-polish", pr: { number: 318, state: "checks" } },
  { id: "envs", title: "Thread environments and cloud", harness: "claude", earlier: ["codex"], mark: "needs", line: "Approve: npm ci --prefer-offline", age: "6m", project: "mako", branch: "thread-envs" },
  { id: "composer", title: "Composer focus after paste", harness: "codex", mark: "unread", line: "Focus returns to the caret after a paste; one test added.", age: "14m", project: "mako", branch: "composer-focus", pr: { number: 317, state: "open" } },
  { id: "dictation-env", title: "Phone dictation probe", harness: "grok", mark: "background", line: "Turn done · watching npm run dev", age: "3m", project: "mako" },
  { id: "billing", title: "Ship the billing webhook retries", harness: "codex", earlier: ["claude"], mark: "working", line: "Edit src/webhooks/retry.ts", age: "10m", project: "api", branch: "billing-webhook-retries" },
  { id: "flaky", title: "Trace the flaky webhook test", harness: "claude", mark: "failed", line: "2 tests failed in webhooks.spec.ts", age: "20m", project: "api" },
  { id: "payments", title: "Wire the payments retry banner", harness: "devin", mark: "starting", line: "Booting a cloud machine", age: "1m", project: "api", branch: "payments-banner" },
  { id: "types", title: "Tighten the webhook types", harness: "grok", mark: "done", age: "3h", project: "api", pr: { number: 88, state: "merged" } },
  { id: "pricing", title: "Make the pricing table responsive", harness: "opencode", mark: "idle", age: "23h", project: "site", branch: "pricing-table" },
  { id: "copy", title: "Pricing page copy pass", harness: "claude", mark: "idle", age: "2d", project: "site" },
]

export const PROJECTS = [
  { name: "mako", branch: "main" },
  { name: "api", branch: "main" },
  { name: "site", branch: "main" },
]

/** What asks for the person right now, across every Thread and Fin: the Inbox. */
export interface Ask {
  id: string
  /** The Thread it's in, and the Fin when a Fin asks. */
  thread: string
  fin?: string
  harness: string
  title: string
  question: string
  kind: "decision" | "approval"
  options: { label: string; detail?: string }[]
  recommended?: number
  age: string
}

export function asksOf(fins: Fin[]): Ask[] {
  const fromFins = fins.flatMap((fin): Ask[] => {
    if (fin.state.kind !== "blocked" || fin.state.on === "lead") return []
    const ask = fin.state.ask
    return [{
      id: fin.agent.nativeId,
      thread: APEX_TITLE,
      fin: fin.agent.title,
      harness: fin.agent.provider,
      title: fin.agent.title,
      question: fin.state.question,
      kind: ask?.kind === "approval" ? "approval" : "decision",
      options: ask?.options ?? [{ label: "Answer" }],
      ...(ask && "recommended" in ask && ask.recommended !== undefined && { recommended: ask.recommended }),
      age: fin.agent.title.startsWith("Quiet") ? "4m" : "9m",
    }]
  })
  return [
    ...fromFins,
    { id: "envs", thread: "Thread environments and cloud", harness: "claude", title: "Thread environments and cloud", question: "Approve: npm ci --prefer-offline", kind: "approval", options: [{ label: "Allow once" }, { label: "Allow for this Thread" }, { label: "Deny" }], age: "6m" },
  ]
}

export const PULL_REQUESTS = 4
export const AUTOMATIONS = 2
