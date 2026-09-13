/**
 * What a harness must provide to join the catalog.
 *
 * The contract is file-shaped, not process-shaped: a provider knows where its
 * harness keeps sessions on disk, how to read one cheaply, and how to read
 * one fully. That is enough for the catalog to notice a session the moment
 * any app — this one, the harness's own TUI, someone else's wrapper — writes
 * to the store, which is what makes sync automatic rather than an import
 * button.
 */

import type { Harness, Thread, ThreadEntry, ThreadRef } from "../format.js"

/** A native session file as discovery sees it: a path and its stat facts. */
export interface NativeFile {
  path: string
  bytes: number
  mtimeMs: number
  revision?: string
  locked?: boolean
}

export interface SessionUpdate {
  entries: ThreadEntry[]
  nextByte: number
  replace: boolean
  replaceFrom?: number
  reset?: boolean
}

export interface SessionFollower {
  readonly offset: number
  next(): Promise<SessionUpdate>
}

export interface SessionProvider {
  harness: Harness
  displayName: string

  /**
   * True for stores where many sessions share one database file: a change
   * under the root cannot be stat-ed per session, so the catalog re-runs
   * discovery for this provider instead of refreshing one path.
   */
  rescanRoot?: boolean
  rescanDebounceMs?: number

  /**
   * A write under the root may not be the session file itself — Grok keeps
   * `summary.json` beside `updates.jsonl`. Return the native file the catalog
   * should refresh, or null to ignore the event. Unset means the watched path
   * is the session file.
   */
  watchTarget?(path: string): string | null

  /**
   * True when `updatedAt` comes from what the provider reads — the newest
   * message's own timestamp — never from the file's mtime. Claude Code appends
   * `last-prompt` and `cost-state` records when a resident CLI exits, so
   * every host restart once bumped every idle session to "now". The catalog
   * then keeps the previous stamp when such a file grows and lets `refine`
   * move it forward only when the appended bytes carry a message.
   */
  activityFromContent?: boolean

  /**
   * Bump when this provider's `peek` starts reading something new from a
   * store (a fork marker, a subagent flag). The catalog re-peeks this
   * provider's cached rows once instead of trusting an entry written under
   * the old rule, and no other provider's cache is touched.
   */
  peekVersion?: number

  /**
   * Directories the harness writes sessions under. Used for discovery and
   * for watching; a root that does not exist simply contributes nothing.
   */
  roots(): string[]

  /** Every native session file under the roots, stat-only — no reads. */
  discover(): Promise<NativeFile[]>

  /**
   * The cheap read: enough of the file to identify the session — id, cwd,
   * title, when. Bounded I/O regardless of file size. Returns null for a
   * file that turns out not to be a session.
   */
  peek(file: NativeFile): Promise<ThreadRef | null>

  /** The full read: the whole conversation, translated. */
  read(path: string): Promise<Thread | null>

  /**
   * Cheap metadata refresh for a session whose file grew. A provider with an
   * out-of-band title store (Codex names threads in its state database after
   * the first turn) returns the current title and cwd without re-reading the
   * file. A provider whose store appends the name later (Claude Code writes
   * an `ai-title` line) scans only the bytes appended since `fromByte`.
   */
  refine?(ref: ThreadRef, fromByte: number): Promise<ThreadRef>

  /**
   * Delete one native session this provider discovered: the file or directory
   * behind `path` and any index rows that name it, nothing else. Only a path
   * under this provider's roots is touched. Returns false when the store has
   * no removable form for it. Used to clean up sessions a test created in a
   * real store, and by any future delete action the desk offers.
   */
  remove?(path: string): Promise<boolean>

  /**
   * Incremental read for live sync: entries appended since `fromByte`, and
   * where to tail from next time. Providers whose store is not append-only
   * (Cursor's SQLite) fall back to a full re-read by omitting this.
   */
  createFollower?(path: string, fromByte: number): SessionFollower | null
  close?(): void
  tail?(
    path: string,
    fromByte: number
  ): Promise<{ entries: ThreadEntry[]; nextByte: number }>
}
