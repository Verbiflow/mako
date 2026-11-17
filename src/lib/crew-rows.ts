import { childGroup, childStateOf, openAsk, type ChildGroup } from "@mako/host/contracts/children"
import type { ChildState } from "@mako/host/contracts/agents"
import type { NativeAgent } from "@mako/host/contracts/native-agents"

export type CrewRow =
  | { kind: "heading"; group: ChildGroup; count: number }
  | { kind: "child"; agent: NativeAgent; group: ChildGroup }
  | { kind: "settled"; done: number; idle: number; open: boolean }

/** Finished and idle: nothing to watch or answer, so they fold into one line the person opens when they want them. */
const SETTLED: ReadonlySet<ChildGroup> = new Set(["idle", "done"])

/**
 * What needs the person and what's live (needs you, working, queued, failed) as headed groups, then the settled ones
 * as one "24 done · 1 idle" line, their groups under it once it's open. A done Fin with a decision still open, its
 * Apex's to make, is never folded: it stays listed under its own Done heading.
 */
export function buildRows(children: readonly NativeAgent[], settledOpen: boolean): CrewRow[] {
  const live: CrewRow[] = []
  const settled: CrewRow[] = []
  const counts = { done: 0, idle: 0 }
  const headings = new Map<CrewRow[], Extract<CrewRow, { kind: "heading" }>>()
  for (const agent of children) {
    const state = childStateOf(agent)
    const next = childGroup(state)
    const out = SETTLED.has(next) && !openAsk(state) && !waitsOutside(state) ? settled : live
    if (out === settled && (next === "done" || next === "idle")) counts[next] += 1
    let heading = headings.get(out)
    if (heading?.group !== next) {
      heading = { kind: "heading", group: next, count: 0 }
      headings.set(out, heading)
      out.push(heading)
    }
    heading.count += 1
    out.push({ kind: "child", agent, group: next })
  }
  if (!settled.length) return live
  return [...live, { kind: "settled", ...counts, open: settledOpen }, ...(settledOpen ? settled : [])]
}

/** An idle Fin waiting on what its report named, such as a pull request's checks, which Mako wakes it on: listed, never folded. */
export function waitsOutside(state: ChildState): boolean {
  return state.kind === "idle" && Boolean(state.waitingOn?.length)
}
