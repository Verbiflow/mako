import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join, sep } from "node:path"
import { within } from "./paths.js"

/**
 * The folders the harnesses keep their sessions in, from where their
 * sessions are: the folder under the home folder each store file sits in
 * (`~/.<harness>`), so a new harness's store is known without a list.
 */
export function harnessStores(sessionFiles: readonly string[], home = homedir()): string[] {
  const folders = new Set<string>()
  for (const path of sessionFiles) {
    if (!within(home, path)) continue
    const [first, second, third] = path.slice(home.length + 1).split("/")
    if (!first || !second) continue
    // Under Library, the application's own folder (`Library/Application Support/<app>`).
    if (first === "Library" && second && third) folders.add(join(home, first, second, third))
    else if (first.startsWith(".")) folders.add(join(home, first))
  }
  return [...folders].sort()
}

/**
 * What harnesses keep outside the stores `harnessStores` finds from session
 * paths: Claude Code's settings beside `~/.claude`, and its temporary folder
 * for this user, where every session's command output goes.
 */
export function harnessScratch(home: string): string[] {
  const uid = process.getuid?.()
  return [join(home, ".claude.json"), ...(uid === undefined ? [] : [`/private/tmp/claude-${uid}`])]
}

/** What `sessionFolders` and backfill read of a catalogued session. */
export interface CataloguedSession {
  harness: string
  nativeId: string
  path: string
  cwd?: string
  currentCwd?: string
  worktrees?: readonly { path: string }[]
  updatedAt?: string
  threadId?: string
  sessionId?: string
}

/** A session that stopped moving this long before a turn began may still be running a long command. */
const OTHERS_SLACK_MS = 5 * 60_000

/**
 * The folders of every session on this Mac that moved since `since`, or
 * that another app reports running now, except `thread`'s own: where their
 * churn during a turn comes from. Read from the catalog, which already
 * lists every harness's sessions.
 */
export function sessionFolders(sessions: readonly CataloguedSession[], running: Readonly<Record<string, { status: string }>>, thread: string, since: number): { folder: string; why: string }[] {
  const out = new Map<string, string>()
  for (const session of sessions) {
    if (thread && session.threadId === thread) continue
    const moved = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN
    const active = running[session.path]?.status === "active"
    if (!active && !(moved >= since - OTHERS_SLACK_MS)) continue
    const why = `${session.harness} session ${session.nativeId.slice(0, 8)}${active ? ", running" : ""}`
    for (const folder of [session.cwd, session.currentCwd, ...(session.worktrees ?? []).map((worktree) => worktree.path)])
      if (folder && !out.has(folder)) out.set(folder, why)
  }
  return [...out].map(([folder, why]) => ({ folder, why }))
}

/**
 * The folders of sessions another app is working in now (another Mako on
 * this device, a harness in a terminal), with whose they are. The home
 * folder and the root hold everything, so they name nothing.
 */
export function outsideFolders(sessions: readonly CataloguedSession[], running: Readonly<Record<string, { status: string }>>, home = homedir()): { folder: string; why: string }[] {
  const active = new Set(Object.entries(running).flatMap(([path, activity]) => (activity.status === "active" ? [path] : [])))
  if (!active.size) return []
  const out = new Map<string, string>()
  for (const session of sessions) {
    if (!active.has(session.path)) continue
    for (const folder of [session.cwd, session.currentCwd, ...(session.worktrees ?? []).map((worktree) => worktree.path)])
      if (folder && folder !== home && folder !== sep && !out.has(folder)) out.set(folder, `${session.harness} session ${session.nativeId.slice(0, 8)}, outside this Mako`)
  }
  return [...out].map(([folder, why]) => ({ folder, why }))
}

/**
 * Every catalogued session's native id but `thread`'s own, lowercase, with
 * whose it is: tools that keep something per session (a memory index, a
 * sync's anchors) file it under the session's id.
 */
export function sessionIds(sessions: readonly CataloguedSession[], thread: string): Map<string, string> {
  const ids = new Map<string, string>()
  for (const session of sessions) if (!(thread && session.threadId === thread)) ids.set(session.nativeId.toLowerCase(), `${session.harness} session ${session.nativeId.slice(0, 8)}`)
  return ids
}

/** A root's id: stable for its path, so a restarted host resumes the same root. */
export function rootId(path: string): string {
  return `r-${createHash("sha256").update(path).digest("hex").slice(0, 16)}`
}
