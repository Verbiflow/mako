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

import type { RecordWriterRule, WriterEvidence } from "../record-writers.js"
import type { WriterEvidenceLookups } from "../record-evidence.js"
import type { Entry, Harness, Thread, ThreadRef, ThreadTail } from "../format.js"
import type { FollowStart, ResumePoint } from "../jsonl.js"
import type { RecordFork, RecordRoot, SessionRecords } from "../harness-records.js"
import type { ChildTranscript } from "../children.js"

/**
 * A session store that exists but could not be read just now, because a
 * writer held it. Answering null instead would say the file is no session,
 * and the catalog would announce a live row removed.
 */
export class SessionUnreadable extends Error {
  constructor(path: string, options?: ErrorOptions) {
    super(`${path} could not be read just now`, options)
    this.name = "SessionUnreadable"
  }
}

/** A native session file as discovery sees it: a path and its stat facts. */
export interface NativeFile {
  path: string
  /**
   * How far the record reaches, in the unit its follower counts: a file's
   * length, or a database record's position (OpenCode's revision, the newest
   * Devin CLI node). It stamps changes and resumes followers; it is a size only
   * for a provider with `tail` or `recent`, which must count it in bytes.
   */
  bytes: number
  mtimeMs: number
  revision?: string
  locked?: boolean
  /** The size of the store the record is in, where `bytes` isn't one: what a decode of it may come to hold, for a provider without `recordBytes`. */
  storeBytes?: number
}

export interface SessionUpdate {
  entries: Entry[]
  nextByte: number
  replace: boolean
  replaceFrom?: number
  reset?: boolean
  /** The update would have read the session whole, and it came to the `wholeLimit` asked: nothing was read, and the follower is done. */
  reload?: true
}

export interface SessionFollower {
  readonly offset: number
  /**
   * What changed since the last update. Where only a whole read of the
   * session can say and the session comes to `wholeLimit` bytes or more, the
   * update is a `reload` instead: its reader pages the session again, which
   * decodes it out of this process.
   */
  next(wholeLimit?: number): Promise<SessionUpdate>
}

export interface SessionProvider {
  harness: Harness
  displayName: string

  /**
   * Whether a write at this path means re-running discovery for the whole
   * provider instead of refreshing one file. True for stores where many
   * sessions share one database: the change cannot be stat-ed per session.
   * A provider can scope it to part of its roots: Cursor's desktop chats
   * share one `state.vscdb`, while its ACP stores are one file per session
   * and refresh individually. Unset means every path refreshes on its own.
   */
  rescanRoot?(path: string): boolean
  /**
   * How long a write is allowed to settle before the catalog refreshes.
   * Writes keep arriving while an agent streams, so this is a throttle with a
   * settle window, never a debounce that starves until the stream pauses.
   */
  rescanDebounceMs?: number

  /**
   * The stat facts for one native file when they are not the file's own stat:
   * a SQLite store's mtime is the newest of the database, its WAL, and its
   * sidecar. Unset means the catalog stats the path directly.
   */
  stat?(path: string): Promise<NativeFile | null>

  /**
   * A write under the root may not be the session file itself — Grok keeps
   * `summary.json` beside `updates.jsonl`. Return the native file the catalog
   * should refresh, or null to ignore the event. Unset means the watched path
   * is the session file.
   */
  watchTarget?(path: string): string | null

  /** Physical files whose changes affect this followed session, including
   * absent WAL/sidecars. Defaults to the session path for file stores. The
   * catalog shares bounded stat subscriptions across viewers; no discovery
   * or transcript reads are needed when these files are unchanged. */
  observationPaths?(path: string): string[]

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

  /**
   * The roots to watch recursively, when not all of them. A root that also
   * holds logs or caches its harness writes constantly is left out and its
   * session stores named in `pollFiles`: a recursive watch hears every one
   * of those writes, at the cost of `fseventsd` and this process.
   */
  watchRoots?(): string[]

  /** Session stores under unwatched roots, checked by `stat` once a second. */
  pollFiles?(): string[]

  /** Every native session file under the roots, stat-only — no reads. */
  discover(): Promise<NativeFile[]>

  /**
   * The cheap read: enough of the file to identify the session — id, cwd,
   * title, when. Bounded I/O regardless of file size. Returns null for a
   * file that turns out not to be a session, and rejects with
   * `SessionUnreadable` for one that could not be read just now.
   */
  peek(file: NativeFile): Promise<ThreadRef | null>

  /**
   * The full read: the whole conversation, translated. Known-path reads and
   * followers may run before discovery completes; initialize their native
   * resources from the path, never from a prior discover() side effect.
   */
  read(path: string): Promise<Thread | null>

  /**
   * A decode continued on a record that only grew: from `from`, a
   * `Thread.resume` an earlier read of `path` gave, the entries a whole read
   * would hold from `from.entry` on. `after` is the id of the entry before
   * it. Null when the record isn't the one that read was of, or a line since
   * reaches back before `from`: only a whole read can say what it changed.
   */
  readFrom?(path: string, from: ResumePoint, after: string | undefined): Promise<ThreadTail | null>

  /**
   * The bytes of this session's own rows, where its store holds other
   * sessions too: what a decode of it reads, which `storeBytes` only bounds.
   * Asked when a decode is about to start, never in discovery. Null when the
   * store can't say.
   */
  recordBytes?(path: string): Promise<number | null>

  /**
   * Where the harness keeps this session's own records, for the record
   * store (`record-store.ts`): every file and database row the session is, beside
   * nothing another session owns, so restoring them under a fresh home gives
   * this reader and the harness the same session. Null when `path` names
   * no session of this store.
   */
  records(path: string): Promise<SessionRecords | null>

  /**
   * Where this reader keeps each root its `records` name, by that name,
   * whether or not any session is there yet: what a restore of a session
   * captured in another home writes into (`RestoreInput.roots`). Without it a
   * root goes to the place under this home it had under the source's, which
   * is where this reader looks only while neither side moved the root
   * (an isolated host's Cursor SDK root, `CODEX_HOME`, an editor's per-platform folder).
   */
  recordRoots?(): RecordRoot[]

  /**
   * Where this store's records state the build that wrote them, the rule
   * `records` hands each capture (`SessionRecords.writer`), here too so a
   * session captured before the rule, or one its harness has since deleted,
   * is read for it from the record store (`RecordStore.rescanWriters`).
   */
  readonly recordWriter?: RecordWriterRule

  /**
   * What this store's harness leaves beside it about which build wrote a
   * session its records name none for (`record-evidence.ts`): its logs, its
   * installs, a bound. Unset where the records or Mako's streams always say.
   */
  writerEvidence?(path: string, reader: WriterEvidenceLookups): Promise<WriterEvidence | null>

  /**
   * How the harness writes one of its sessions again as its own fork, under
   * a new native id: what a restore does when the destination's copy went on
   * without Mako (`RestoreInput.fork`). Unset where the harness's records
   * can't be forked yet; such a restore writes nothing.
   */
  readonly fork?: RecordFork

  /**
   * The session's own history counts what its child agents spent, in the
   * turns they ran in: Grok's store does (its `turn_completed`, and a woken
   * subagent's turns read beside it), and Devin's reader does from the
   * store's chains. Unset, a child's spend is in its own history alone
   * (`children`), and a conversation's history totals the session's and
   * its children's. Their live meters count both either way.
   */
  readonly subagentSpendInParent?: true

  /**
   * The child agents this session started, as the store links them to it,
   * nested ones included (`spawnedBy`). Reads what links them (sidecars,
   * index rows, the session's own lines that name a child) and never a
   * child's transcript, so listing twenty children costs no more than their
   * links. Each child's `path` opens through `read`, `createFollower` and
   * `tail` like any session's, with `ref.childOf` set, and `peek` never lists
   * one as a row. `records` of the session covers its children's records.
   * Null when `path` names no session of this store; unset when the harness
   * starts no child agents this reader can see.
   */
  children?(path: string): Promise<ChildTranscript[] | null>

  /**
   * Mako wrote records into this harness's store itself (a restore of a
   * session its harness deleted, `SessionCatalog.restoreKept`): a listing
   * of the store the reader keeps for a while (Codex's rollouts, Cursor's
   * child stores) is stale, so the session and its children are found the
   * moment the restore returns. Unset where the reader keeps none.
   */
  storeWritten?(): void

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
   * (Cursor's SQLite) fall back to a full re-read by omitting this. A
   * reader that continues decodes (`readFrom`) takes over from `start`.
   */
  createFollower?(path: string, fromByte: number, start?: FollowStart): SessionFollower | null
  close?(): void
  tail?(
    path: string,
    fromByte: number
  ): Promise<{ entries: Entry[]; nextByte: number }>
  /**
   * The newest exchanges of a store with no byte tail to read, translated
   * from about its last `bytes` of messages and starting at a prompt. Null
   * when that reaches back to the start, where a full read costs the same.
   */
  recent?(path: string, bytes: number): Promise<Entry[] | null>
}
