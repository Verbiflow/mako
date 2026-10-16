import { z } from "zod"
import type { ChildTranscript } from "./children.js"
import type { Thread } from "./format.js"
import type { SessionProvider } from "./providers/types.js"

/**
 * Whether every child agent a harness's sessions name is on this Mac and
 * reads: the proof `npm run audit:children` and `harness:doctor --children`
 * report, and the pair and fixture tests hold. For each session with
 * children it checks that the parent's own transcript has the row of the
 * call each child names (`toolId`), that each located child reads through
 * its harness's reader with its link to the parent, and it counts the
 * children its reader could only list as partial or missing, by reason.
 */

/** What a reader threw, as a report line. */
const FailureText = z.union([z.instanceof(Error).transform((error) => error.message), z.unknown().transform(String)])

export interface ChildFailure {
  parent: string
  child: string
  problem: string
}

export interface ChildCompleteness {
  harness: string
  sessions: number
  /** Sessions with at least one child. */
  parents: number
  children: number
  complete: number
  partial: number
  missing: number
  /** Children started by another child. */
  nested: number
  /** Children whose starting call is named. */
  linked: number
  /**
   * Of those, direct children whose parent's transcript reads whole, so
   * their call can be looked for among its rows; a reader that shows only a
   * long record's newest part leaves the rest unchecked.
   */
  linkChecked: number
  /** Of the checked, children whose call is a row of the parent's transcript. */
  linkedRows: number
  /** Located children whose transcript read, with entries and its link. */
  decoded: number
  /** Why children are partial or missing, with how many of each. */
  reasons: Record<string, number>
  failures: ChildFailure[]
  /** Listing every session's children, then reading them. */
  listMs: number
  readMs: number
  slowestList?: { path: string; ms: number }
}

export interface CompletenessOptions {
  /** Read each located child and each parent; off lists links only. */
  decode?: boolean
  /** Stop after this many sessions with children. */
  parents?: number
}

/** The children of every session `readers` discover, grouped by harness. */
export async function childCompleteness(readers: readonly SessionProvider[], options: CompletenessOptions = {}): Promise<ChildCompleteness[]> {
  const byHarness = new Map<string, ChildCompleteness>()
  for (const reader of readers) {
    if (!reader.children) continue
    const report = byHarness.get(reader.harness) ?? empty(reader.harness)
    byHarness.set(reader.harness, report)
    for (const file of await reader.discover().catch(() => [])) {
      if (options.parents !== undefined && report.parents >= options.parents) break
      report.sessions++
      const started = performance.now()
      const children = await reader.children(file.path).catch((error) => {
        report.failures.push({ parent: file.path, child: "", problem: `listing failed: ${FailureText.parse(error)}` })
        return null
      })
      const ms = performance.now() - started
      report.listMs += ms
      if (!report.slowestList || ms > report.slowestList.ms) report.slowestList = { path: file.path, ms: Math.round(ms) }
      if (!children?.length) continue
      report.parents++
      await check(reader, file.path, children, report, options.decode ?? true)
    }
  }
  return [...byHarness.values()].map((report) => ({ ...report, listMs: Math.round(report.listMs), readMs: Math.round(report.readMs) }))
}

async function check(reader: SessionProvider, parentPath: string, children: readonly ChildTranscript[], report: ChildCompleteness, decode: boolean): Promise<void> {
  const started = performance.now()
  const parent = decode ? await reader.read(parentPath).catch(() => null) : null
  const rows = parent ? toolRows(parent) : null
  for (const child of children) {
    report.children++
    report[child.state.kind]++
    if (child.state.kind !== "complete") report.reasons[child.state.reason] = (report.reasons[child.state.reason] ?? 0) + 1
    if (child.spawnedBy) report.nested++
    if (child.toolId) {
      report.linked++
      // A nested child's call is a row of the child that started it, not of the session.
      if (rows && !child.spawnedBy) {
        report.linkChecked++
        if (rows.has(child.toolId)) report.linkedRows++
        else report.failures.push({ parent: parentPath, child: child.nativeId, problem: `its call ${child.toolId} is no row of the parent's transcript` })
      }
    }
    if (!decode || !child.path) continue
    const thread = await reader.read(child.path).catch((error) => {
      report.failures.push({ parent: parentPath, child: child.nativeId, problem: `reading failed: ${FailureText.parse(error)}` })
      return null
    })
    if (!thread) {
      if (!child.archived) report.failures.push({ parent: parentPath, child: child.nativeId, problem: `${child.path} reads as no transcript` })
      continue
    }
    if (thread.ref.childOf?.nativeId === undefined)
      report.failures.push({ parent: parentPath, child: child.nativeId, problem: "its transcript doesn't name its parent (ref.childOf)" })
    else if (!thread.entries.length)
      report.failures.push({ parent: parentPath, child: child.nativeId, problem: "its transcript reads with no entries" })
    else report.decoded++
  }
  report.readMs += performance.now() - started
}

/** The ids of every tool row a transcript draws. */
function toolRows(thread: Thread): Set<string> {
  const ids = new Set<string>()
  for (const entry of thread.entries) if (entry.type === "tool" && entry.id) ids.add(entry.id)
  return ids
}

function empty(harness: string): ChildCompleteness {
  return {
    harness, sessions: 0, parents: 0, children: 0, complete: 0, partial: 0, missing: 0, nested: 0,
    linked: 0, linkChecked: 0, linkedRows: 0, decoded: 0, reasons: {}, failures: [], listMs: 0, readMs: 0,
  }
}

/** A report as lines, the way `audit:children` and the doctor print it. */
export function formatChildCompleteness(report: ChildCompleteness): string {
  const lines = [report.harness]
  const row = (label: string, text: string) => lines.push(`  ${label.padEnd(10)}${text}`)
  row("sessions", `${report.sessions}, ${report.parents} with children`)
  row("children", `${report.children}: ${report.complete} complete · ${report.partial} partial · ${report.missing} missing · ${report.nested} nested`)
  row("links", `${report.linked} name their call · ${report.linkedRows} of ${report.linkChecked} checked against a whole parent transcript are its rows`)
  row("decoded", `${report.decoded} of ${report.children - report.missing} located read with their link`)
  for (const [reason, count] of Object.entries(report.reasons).sort((left, right) => right[1] - left[1])) row("", `${count} × ${reason}`)
  row("cost", `listing ${report.listMs} ms, reading ${report.readMs} ms${report.slowestList ? ` · slowest listing ${report.slowestList.ms} ms` : ""}`)
  for (const failure of report.failures.slice(0, 20)) row("✗", `${failure.child || failure.parent}: ${failure.problem}`)
  if (report.failures.length > 20) row("", `+${report.failures.length - 20} more`)
  return lines.join("\n")
}
