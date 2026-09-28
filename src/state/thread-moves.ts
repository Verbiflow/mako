import type { ThreadRef } from "@/lib/types"
import { listedSession } from "../../electron/contracts/thread-list.ts"
import { prefsStore, setPref } from "@/state/prefs"
import { moveThreadTab } from "@/state/thread-tabs"
import { followMovedThread } from "@/state/thread-viewing"
import { followMovedTranscripts } from "@/state/viewer"

/**
 * A harness can move a session's record while the session runs: Claude Code
 * files a session under the folder it works in, so entering a worktree moves
 * the record into that worktree's project directory. The catalog reports the
 * new record and the old one's removal in either order, possibly scans
 * apart, so a session whose row left the list is remembered by where it was.
 */
const departed = new Map<string, string>()
const DEPARTED_MAX = 500

export interface ThreadMove {
  from: string
  to: ThreadRef
}

/** The sessions listed in `next` at another path than they last were. */
export function threadMoves(previous: readonly ThreadRef[], next: readonly ThreadRef[]): ThreadMove[] {
  const before = new Map(previous.map((ref) => [listedSession(ref), ref.path]))
  const moves: ThreadMove[] = []
  const listed = new Set<string>()
  for (const ref of next) {
    const session = listedSession(ref)
    listed.add(session)
    const from = before.get(session) ?? departed.get(session)
    departed.delete(session)
    if (from !== undefined && from !== ref.path) moves.push({ from, to: ref })
  }
  for (const [session, path] of before) {
    if (listed.has(session)) continue
    departed.delete(session)
    departed.set(session, path)
  }
  for (const session of departed.keys()) {
    if (departed.size <= DEPARTED_MAX) break
    departed.delete(session)
  }
  return moves
}

/**
 * What this window holds by a session's path follows the session to its new
 * record. Whether it is running or asking stays with what reports that: a
 * live conversation follows its record itself (`acp.bindThreads`).
 */
export function followThreadMoves(previous: readonly ThreadRef[], next: readonly ThreadRef[]): void {
  for (const { from, to } of threadMoves(previous, next)) {
    moveThreadTab(from, to.path)
    movePreferences(from, to.path)
    followMovedTranscripts(from, to.path)
    followMovedThread(from, to)
  }
}

function movePreferences(from: string, to: string): void {
  const { titleOverrides, pinnedThreads } = prefsStore.get()
  const title = titleOverrides[from]
  if (title !== undefined) {
    const next = { ...titleOverrides }
    delete next[from]
    setPref("titleOverrides", { ...next, [to]: next[to] ?? title })
  }
  if (pinnedThreads.includes(from))
    setPref("pinnedThreads", pinnedThreads.flatMap((path) => (path === from ? (pinnedThreads.includes(to) ? [] : [to]) : [path])))
}
