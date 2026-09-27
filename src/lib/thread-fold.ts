import type { ThreadGroup } from "../../electron/contracts/thread-groups.ts"
import type { ThreadRef } from "@/lib/types"
import type { AcpPresence } from "@/state/acp-presence"
import { threadStatusPriority, type ThreadStatus } from "@/state/thread-status"

/** A rail row as the fold sees it: a catalog row, or a live conversation with none. */
export type FoldRow =
  | { kind: "native"; key: string; ref: ThreadRef }
  | { kind: "live"; key: string; presence: AcpPresence }

/** A Thread with two or more rows, shown as one. */
export interface FoldedThread {
  thread: string
  /** The row that stands for the Thread: its first Session that has a row. */
  lead: string
  /** The Thread's rows in tab order, the lead first. */
  members: readonly FoldRow[]
}

export interface ThreadFold {
  byLead: ReadonlyMap<string, FoldedThread>
  /** Rows the rail leaves out because their Thread's lead row shows them. */
  hidden: ReadonlySet<string>
}

export const EMPTY_FOLD: ThreadFold = { byLead: new Map(), hidden: new Set() }

/** Marks a folded row shows; the tip names every Session. */
export const FOLD_GLYPHS = 3

export function foldRowSession(row: FoldRow): string | undefined {
  return row.kind === "native" ? row.ref.sessionId : row.presence.sessionId
}

export function foldRowHarness(row: FoldRow): string {
  return row.kind === "native" ? row.ref.harness : row.presence.harness
}

/**
 * Fold rows that share a multi-Session Thread into the row of its first
 * Session. Catalog rows come before live ones, so when a Session has both
 * the catalog row stands for it. A Thread with only one row visible stays
 * an ordinary row.
 */
export function foldThreads(
  rows: Iterable<FoldRow>,
  groups: Readonly<Record<string, ThreadGroup>>,
  threadOf: Readonly<Record<string, string>>
): ThreadFold {
  const bySession = new Map<string, FoldRow>()
  const duplicates: string[] = []
  const threads = new Set<string>()
  for (const row of rows) {
    const session = foldRowSession(row)
    const thread = session === undefined ? undefined : threadOf[session]
    if (session === undefined || thread === undefined) continue
    if (bySession.has(session)) duplicates.push(row.key)
    else bySession.set(session, row)
    threads.add(thread)
  }
  if (!threads.size) return EMPTY_FOLD
  const byLead = new Map<string, FoldedThread>()
  const hidden = new Set(duplicates)
  for (const thread of threads) {
    const members = groups[thread]?.sessions.flatMap((session) => bySession.get(session.id) ?? []) ?? []
    const [lead, ...rest] = members
    if (!lead || !rest.length) continue
    byLead.set(lead.key, { thread, lead: lead.key, members })
    for (const row of rest) hidden.add(row.key)
  }
  return { byLead, hidden }
}

/** A live conversation's state in the rail's status vocabulary. */
export function presenceThreadStatus(presence: AcpPresence): ThreadStatus {
  if (presence.status === "needs-permission") return { kind: "needs-permission", since: presence.createdAt }
  if (presence.status === "failed") return { kind: "failed", at: presence.createdAt }
  if (presence.status === "running" || presence.status === "starting")
    return { kind: "working", since: presence.createdAt }
  return { kind: "idle" }
}

/** The status that asks the most of you among a Thread's rows. */
export function foldedThreadStatus(
  members: readonly FoldRow[],
  nativeStatus: (ref: ThreadRef) => ThreadStatus
): ThreadStatus {
  let shown: ThreadStatus = { kind: "idle" }
  for (const row of members) {
    const status = row.kind === "native" ? nativeStatus(row.ref) : presenceThreadStatus(row.presence)
    if (threadStatusPriority(status) > threadStatusPriority(shown)) shown = status
  }
  return shown
}
