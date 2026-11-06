import { createHash } from "node:crypto"
import { existsSync, renameSync, rmSync } from "node:fs"
import type { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import type { Actor } from "../contracts/thread-identity.js"
import type { ExecutionOwner } from "../contracts/thread-execution.js"

/**
 * A Thread is one conversation (`docs/one-conversation.md`). Builds before it let a Thread hold several Sessions as
 * tabs; the split gives each of those Sessions a Thread of its own in the same place, and records enough to undo it.
 *
 * `thread_places`: a Thread that works in another Thread's place (its worktree on each device, its project and
 * branch) names that Thread, the place's owner. A split, a fork and a second conversation opened beside one all share
 * their source's place; the owner keeps the `thread_worktrees` row.
 *
 * `thread_splits`: each Thread a split made, the Thread and Session it came from, the Session's tab position and the
 * source's title then, so `undoThreadSplits` can put every Session back where it was.
 */
export const SPLIT_TABLES = `
CREATE TABLE IF NOT EXISTS thread_places (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id), place_thread TEXT NOT NULL REFERENCES threads(id),
  why TEXT NOT NULL CHECK (why IN ('split', 'fork', 'new')), created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS thread_places_place ON thread_places(place_thread);
CREATE TABLE IF NOT EXISTS thread_splits (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id), from_thread TEXT NOT NULL REFERENCES threads(id),
  session_id TEXT NOT NULL REFERENCES sessions(id), position INTEGER NOT NULL, from_title TEXT, split_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS thread_splits_from ON thread_splits(from_thread);
`

/** The `store_meta` key the first split stamps, with when it ran and what it split. */
export const SPLIT_STAMP = "one-conversation"

/** The copy of the store kept beside it before the first split changes anything (`keepPreSplitCopy`). */
export function preSplitCopyPath(path: string): string {
  return `${path}.before-one-conversation`
}

export interface SplitCounts {
  /** Threads that held several Sessions and now hold one each. */
  threads: number
  /** Threads the split made, one for each Session after a Thread's first. */
  made: number
  /** Parent edges that followed their parent Session, or their child's run, into a Thread the split made. */
  edges: number
  /** Threads left whole until they're here again: a Session runs elsewhere or the Thread is moving. */
  deferred: number
}

export interface SplitOptions {
  self: ExecutionOwner
  now: number
  actor: Actor
  /** Called after each Thread is split, inside the transaction; a test stops the process here to prove a crash loses nothing. */
  afterThread?: (done: number) => void
}

const IdRowSchema = z.object({ id: z.string() })
const MemberRowSchema = z.object({ session_id: z.string(), position: z.number(), created_at: z.number() })
const ThreadRowSchema = z.object({ id: z.string(), owner_id: z.string(), title: z.string().nullable(), merged_into: z.string().nullable() })
const ExecutionRowSchema = z.object({ owner_kind: z.string().nullable(), owner_id: z.string().nullable() })
const EdgeRowSchema = z.object({ child_thread: z.string(), record: z.string(), run_harness: z.string().nullable(), run_native_id: z.string().nullable() })
const ParentSessionSchema = z.object({ parentSession: z.string() })
const SplitRowSchema = z.object({ thread_id: z.string(), from_thread: z.string(), session_id: z.string(), position: z.number() })
const MergedSchema = z.object({ merged_into: z.string().nullable() })
const CountSchema = z.object({ count: z.number() })

/**
 * The Thread a split makes for `session` of `thread`: derived from the two, so every store that splits the same Thread
 * (this Mac's and the cloud machine's that holds it) names the result alike, and a split repeated after an undo makes
 * the same Thread again. Formatted as a version 8 UUID.
 */
export function splitThreadId(thread: string, session: string): string {
  const hex = createHash("sha256").update(`mako-thread-split\0${thread}\0${session}`).digest("hex")
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Threads still holding more than one Session, oldest first. */
export function threadsToSplit(db: DatabaseSync): string[] {
  return db.prepare(`SELECT m.thread_id AS id FROM memberships m JOIN threads t ON t.id = m.thread_id
    WHERE t.merged_into IS NULL GROUP BY m.thread_id HAVING count(*) > 1 ORDER BY min(t.created_at), m.thread_id`)
    .all().map((row) => IdRowSchema.parse(row).id)
}

/**
 * Before the first split: the whole store copied beside it (`preSplitCopyPath`), written under another name and
 * renamed into place, so a copy that exists is whole. Kept as it is once made; a later split keeps the first copy.
 * Outside any transaction (SQLite's `VACUUM INTO` can't run in one), and only when there is something to split.
 */
export function keepPreSplitCopy(db: DatabaseSync, path: string): string | undefined {
  const copy = preSplitCopyPath(path)
  if (existsSync(copy)) return undefined
  try {
    if (!threadsToSplit(db).length) return undefined
  } catch {
    // A store without its tables yet holds nothing to split.
    return undefined
  }
  const partial = `${copy}.partial`
  rmSync(partial, { force: true })
  db.prepare("VACUUM INTO ?").run(partial)
  renameSync(partial, copy)
  return copy
}

/**
 * Splits every Thread that holds several Sessions into one Thread per Session, in the caller's transaction. The
 * Session first in tab order keeps the Thread: its ID, title, purpose, worktree, move history and parent edge as a
 * child. Each other Session gets the Thread `splitThreadId` names, owned by the same person and created when the
 * Session was, sharing the source's place (`thread_places`). A parent edge whose parent Session went follows it, and
 * a child edge (with its reports) follows the Session its run is. A Thread with a Session that runs elsewhere, or that
 * is moving, is left whole and split once it's here again. Idempotent: a store with nothing left to split is unchanged.
 */
export function splitThreads(db: DatabaseSync, options: SplitOptions): SplitCounts {
  const counts: SplitCounts = { threads: 0, made: 0, edges: 0, deferred: 0 }
  const actor = JSON.stringify(options.actor)
  const members = db.prepare(`SELECT m.session_id, m.position, s.created_at FROM memberships m JOIN sessions s ON s.id = m.session_id
    WHERE m.thread_id = ? ORDER BY m.position, m.session_id`)
  const threadRow = db.prepare("SELECT id, owner_id, title, merged_into FROM threads WHERE id = ?")
  const execution = db.prepare("SELECT owner_kind, owner_id FROM executions WHERE session_id = ?")
  const moving = db.prepare("SELECT count(*) AS count FROM moves WHERE thread_id = ? AND phase IN ('leaving', 'released')")
  const existing = db.prepare("SELECT merged_into FROM threads WHERE id = ?")
  const insertThread = db.prepare("INSERT INTO threads (id, owner_id, created_at, created_by) VALUES (?, ?, ?, ?)")
  const unmerge = db.prepare("UPDATE threads SET merged_into = NULL, revision = revision + 1 WHERE id = ?")
  const move = db.prepare("UPDATE memberships SET thread_id = ?, position = 0 WHERE session_id = ?")
  const record = db.prepare(`INSERT INTO thread_splits (thread_id, from_thread, session_id, position, from_title, split_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (thread_id) DO UPDATE SET from_thread = excluded.from_thread, session_id = excluded.session_id, position = excluded.position,
      from_title = excluded.from_title, split_at = excluded.split_at`)
  const place = db.prepare("INSERT OR REPLACE INTO thread_places (thread_id, place_thread, why, created_at) VALUES (?, ?, 'split', ?)")
  const bump = db.prepare("UPDATE threads SET revision = revision + 1 WHERE id = ?")
  const parentEdges = db.prepare("SELECT child_thread, record, run_harness, run_native_id FROM thread_parents WHERE parent_thread = ?")
  const childEdge = db.prepare("SELECT child_thread, record, run_harness, run_native_id FROM thread_parents WHERE child_thread = ?")
  const reparent = db.prepare("UPDATE thread_parents SET parent_thread = ?, record = json_set(record, '$.parent', ?) WHERE child_thread = ?")
  const rechild = db.prepare("UPDATE thread_parents SET child_thread = ?, record = json_set(record, '$.child', ?) WHERE child_thread = ?")
  const rereport = db.prepare("UPDATE thread_reports SET child_thread = ?, record = json_set(record, '$.child', ?) WHERE child_thread = ?")
  const runOf = db.prepare(`SELECT session_id AS id FROM sources WHERE harness = ? AND key = ?
    UNION SELECT session_id FROM native_claims WHERE harness = ? AND native_id = ?
    UNION SELECT session_id FROM locators WHERE harness = ? AND native_id = ?`)
  const canonical = canonicalSessions(db)
  const [selfKind, selfId] = options.self.kind === "device" ? ["device", options.self.device] : ["cloud", options.self.runtime]

  for (const id of threadsToSplit(db)) {
    const found = threadRow.get(id)
    if (!found) continue
    const thread = ThreadRowSchema.parse(found)
    const sessions = members.all(id).map((row) => MemberRowSchema.parse(row))
    const here = sessions.every((member) => {
      const row = execution.get(member.session_id)
      if (!row) return true
      const owner = ExecutionRowSchema.parse(row)
      return owner.owner_kind === selfKind && owner.owner_id === selfId
    })
    if (!here || CountSchema.parse(moving.get(id)).count > 0) {
      counts.deferred += 1
      continue
    }
    const made = new Map<string, string>()
    for (const member of sessions.slice(1)) {
      const next = splitThreadId(id, member.session_id)
      const prior = existing.get(next)
      if (!prior) insertThread.run(next, thread.owner_id, member.created_at, actor)
      else if (MergedSchema.parse(prior).merged_into !== null) unmerge.run(next)
      move.run(next, member.session_id)
      record.run(next, id, member.session_id, member.position, thread.title, options.now)
      place.run(next, id, options.now)
      made.set(member.session_id, next)
      counts.made += 1
    }
    for (const row of parentEdges.all(id)) {
      const edge = EdgeRowSchema.parse(row)
      const parsed = ParentSessionSchema.safeParse(JSON.parse(edge.record))
      const to = parsed.success ? made.get(canonical(parsed.data.parentSession)) : undefined
      if (!to) continue
      reparent.run(to, to, edge.child_thread)
      counts.edges += 1
    }
    const asChild = childEdge.get(id)
    if (asChild) {
      const edge = EdgeRowSchema.parse(asChild)
      const runs = edge.run_harness && edge.run_native_id
        ? runOf.all(edge.run_harness, edge.run_native_id, edge.run_harness, edge.run_native_id, edge.run_harness, edge.run_native_id).map((row) => canonical(IdRowSchema.parse(row).id))
        : []
      const to = runs.map((session) => made.get(session)).find((thread) => thread !== undefined)
      if (to) {
        rechild.run(to, to, id)
        rereport.run(to, to, id)
        counts.edges += 1
      }
    }
    bump.run(id)
    counts.threads += 1
    options.afterThread?.(counts.threads)
  }
  if (counts.threads)
    db.prepare("INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(SPLIT_STAMP, JSON.stringify({ at: options.now, threads: counts.threads, made: counts.made, edges: counts.edges }))
  return counts
}

export interface UndoCounts {
  /** Sessions back in the Thread they were split from. */
  rejoined: number
  /** Threads a split made that hold something since (a Session added later), left as they are. */
  kept: number
}

/**
 * The way back, for a build that groups Sessions again or a person who wants a split Thread whole: each Thread a split
 * made gives its Session back to the Thread it came from, at its old tab position, with the parent and child edges
 * that followed it, and is merged into that Thread so anything that still names it finds the Thread it joined. One that
 * holds anything else now is left alone. In the caller's transaction; a store with nothing split is unchanged.
 */
export function undoThreadSplits(db: DatabaseSync): UndoCounts {
  const counts: UndoCounts = { rejoined: 0, kept: 0 }
  const rows = db.prepare("SELECT thread_id, from_thread, session_id, position FROM thread_splits ORDER BY from_thread, position").all()
    .map((row) => SplitRowSchema.parse(row))
  const membersOf = db.prepare("SELECT session_id AS id FROM memberships WHERE thread_id = ?")
  const fromRow = db.prepare("SELECT merged_into FROM threads WHERE id = ?")
  const move = db.prepare("UPDATE memberships SET thread_id = ?, position = ? WHERE session_id = ?")
  const reparent = db.prepare("UPDATE thread_parents SET parent_thread = ?, record = json_set(record, '$.parent', ?) WHERE parent_thread = ?")
  const rechild = db.prepare("UPDATE thread_parents SET child_thread = ?, record = json_set(record, '$.child', ?) WHERE child_thread = ?")
  const rereport = db.prepare("UPDATE thread_reports SET child_thread = ?, record = json_set(record, '$.child', ?) WHERE child_thread = ?")
  const merge = db.prepare("UPDATE threads SET merged_into = ?, revision = revision + 1 WHERE id = ?")
  const unplace = db.prepare("DELETE FROM thread_places WHERE thread_id = ?")
  const replace = db.prepare("UPDATE thread_places SET place_thread = ? WHERE place_thread = ?")
  const forget = db.prepare("DELETE FROM thread_splits WHERE thread_id = ?")
  const bump = db.prepare("UPDATE threads SET revision = revision + 1 WHERE id = ?")
  for (const row of rows) {
    const held = membersOf.all(row.thread_id).map((member) => IdRowSchema.parse(member).id)
    const from = fromRow.get(row.from_thread)
    if (held.length !== 1 || held[0] !== row.session_id || !from || MergedSchema.parse(from).merged_into !== null) {
      counts.kept += 1
      continue
    }
    // A Fin started under the split Thread can share a name with one of the source's; that Thread stays split.
    db.exec("SAVEPOINT rejoin")
    try {
      move.run(row.from_thread, row.position, row.session_id)
      reparent.run(row.from_thread, row.from_thread, row.thread_id)
      rechild.run(row.from_thread, row.from_thread, row.thread_id)
      rereport.run(row.from_thread, row.from_thread, row.thread_id)
      unplace.run(row.thread_id)
      replace.run(row.from_thread, row.thread_id)
      merge.run(row.from_thread, row.thread_id)
      forget.run(row.thread_id)
      bump.run(row.from_thread)
      db.exec("RELEASE rejoin")
      counts.rejoined += 1
    } catch {
      db.exec("ROLLBACK TO rejoin")
      db.exec("RELEASE rejoin")
      counts.kept += 1
    }
  }
  if (!CountSchema.parse(db.prepare("SELECT count(*) AS count FROM thread_splits").get()).count)
    db.prepare("DELETE FROM store_meta WHERE key = ?").run(SPLIT_STAMP)
  return counts
}

/** A Session as it is now, following merges. */
function canonicalSessions(db: DatabaseSync): (session: string) => string {
  const row = db.prepare("SELECT merged_into FROM sessions WHERE id = ?")
  return (session) => {
    let current = session
    for (let hops = 0; hops < 64; hops += 1) {
      const found = row.get(current)
      const merged = found ? MergedSchema.parse(found).merged_into : null
      if (!merged) return current
      current = merged
    }
    return current
  }
}

/**
 * Whether a Thread is one conversation on this host (`docs/one-conversation.md`). An installed Mako's is, and `0` is the
 * way back. A cloud machine's Threads stay whole: its Mac names them, and a device gives it Sessions to file in them. A
 * checkout's host shares the person's store, so only an isolated one may ask: running a branch never rewrites it.
 */
export function wantsOneConversation(environment: { packaged: boolean; isolated: boolean }, cloudMachine: boolean, asked: string | undefined): boolean {
  if (cloudMachine || asked === "0") return false
  return environment.packaged || (asked === "1" && environment.isolated)
}
