import { z } from "zod"
import { ThreadIdSchema } from "./ids.js"

/*
 * Attribution: which Thread, Session, turn and tool call made each change on
 * disk, and how sure the tracker is. Every device keeps one journal of
 * changes to the roots it tracks (a Thread's checkout, an attached folder);
 * every entry names its author with a stated certainty, and never claims more
 * than its evidence shows. A laptop tracker and a cloud machine's tracker
 * write the same records and pass the same conformance suite
 * (`attribution-conformance.ts`), so either can read the other's journal.
 */

const NAME = /^[A-Za-z0-9._:-]{1,160}$/

/** A file's content address: the algorithm, then the digest in hex. A peer that hashes another way rehashes on upload. */
export const ContentRefSchema = z.string().regex(/^(sha256|blake3):[0-9a-f]{64}$/)
/** Minted when a journal is created; a peer holding another id starts over instead of trusting stale numbers. */
export const JournalIdSchema = z.uuid()
/** An entry's position in its journal, from 1, with no gaps. */
export const JournalSeqSchema = z.number().int().positive()
export const RootIdSchema = z.string().regex(NAME)
export const SessionRefSchema = z.string().regex(NAME)
export const AbsolutePathSchema = z.string().min(1).max(4096).startsWith("/")
/** Relative to its root, with `/` between folders, never `..` or a leading `/`. */
export const RootPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) => !path.startsWith("/") && !path.split("/").some((part) => part === ".." || part === "." || part === ""),
    "a path inside its root"
  )
/** Epoch milliseconds. */
export const InstantSchema = z.number().int().nonnegative()
/** Nanoseconds since the epoch, as digits: past what a double holds exactly. */
export const NanosSchema = z.string().regex(/^\d+$/)

export type ContentRef = z.infer<typeof ContentRefSchema>
export type JournalId = z.infer<typeof JournalIdSchema>
export type JournalSeq = z.infer<typeof JournalSeqSchema>
export type RootId = z.infer<typeof RootIdSchema>
export type SessionRef = z.infer<typeof SessionRefSchema>
export type RootPath = z.infer<typeof RootPathSchema>

/** What the tracker watches: a Thread's checkout (each repository of it) or a folder attached to a Thread. */
export const TrackedRootSchema = z
  .object({
    id: RootIdSchema,
    path: AbsolutePathSchema,
    kind: z.enum(["workspace", "attached"]),
    /** Ignored files worth tracking anyway, as globs relative to the root (a recipe's `carry`). */
    carry: z.array(z.string().min(1).max(512)).max(256).optional(),
  })
  .strict()
export type TrackedRoot = z.infer<typeof TrackedRootSchema>

/** One Session of a Thread and, as far as known, the turn, tool call or background work inside it. */
export const AuthorSchema = z
  .object({
    thread: ThreadIdSchema,
    session: SessionRefSchema,
    turn: z.string().min(1).max(200).optional(),
    call: z.string().min(1).max(200).optional(),
    /** Background work the Session started (a dev server, a watcher), by its id. */
    work: z.string().min(1).max(200).optional(),
  })
  .strict()
export type Author = z.infer<typeof AuthorSchema>

/**
 * How sure the tracker is of an entry's author, strongest first:
 * - `exact`: the change is what a tool call reported (its patch or content matches), during or just after the call;
 * - `named`: a call in flight named the path or a folder holding it, and only one Thread's calls did;
 * - `window`: only one Thread had anything running, and the path is in its checkout;
 * - `ambiguous`: several Threads could have, or the tracker couldn't see when it happened;
 * - `person`: Mako's own editor wrote it, or nothing was running in any Thread.
 * `mako` stands apart: Mako's own operation (a Git command it ran, a move) wrote it, known exactly.
 */
export const CERTAINTIES = ["exact", "named", "window", "ambiguous", "person", "mako"] as const
export const CertaintySchema = z.enum(CERTAINTIES)
export type Certainty = z.infer<typeof CertaintySchema>

/** How a call named the path, for `named`. */
export const NamingSchema = z.enum(["effect", "command", "target"])

export const AttributionSchema = z.discriminatedUnion("certainty", [
  z
    .object({
      certainty: z.literal("exact"),
      author: AuthorSchema,
      /** The reported effect the change matched. */
      effect: z.enum(["create", "modify", "write", "delete", "rename"]),
    })
    .strict(),
  z.object({ certainty: z.literal("named"), author: AuthorSchema, by: NamingSchema }).strict(),
  z
    .object({
      certainty: z.literal("window"),
      author: AuthorSchema,
      during: z.enum(["turn", "call", "background"]),
    })
    .strict(),
  z
    .object({
      certainty: z.literal("ambiguous"),
      /** Who could have; empty when no Thread was running but the tracker can't rule one out. */
      candidates: z.array(AuthorSchema).max(16),
      reason: z.enum([
        /** Several Threads had something running. */
        "several-threads",
        /** One Thread was running, but the path isn't in its checkout. */
        "outside-checkout",
        /** The change was there when tracking began. */
        "before-tracking",
        /** Events were lost, so the change could have happened any time in the gap. */
        "lost-events",
      ]),
    })
    .strict(),
  z.object({ certainty: z.literal("person"), via: z.enum(["editor", "no-activity"]) }).strict(),
  z
    .object({
      certainty: z.literal("mako"),
      /** What Mako did, in a few words: `git stash push`, `worktree move`. */
      operation: z.string().min(1).max(200),
    })
    .strict(),
])
export type Attribution = z.infer<typeof AttributionSchema>

/** The thread an attribution puts the change on, when it puts it on one. */
export function attributedThread(attribution: Attribution): string | undefined {
  return "author" in attribution ? attribution.author.thread : undefined
}

export const ChangeKindSchema = z.enum(["create", "modify", "delete", "rename"])
export type ChangeKind = z.infer<typeof ChangeKindSchema>

/**
 * How the tracker came to see a change:
 * - `event`: the watcher reported it live;
 * - `rescan`: events were lost, and a walk compared against the stat cache found it;
 * - `history`: after a restart, the system's own history (FSEvents ids) named it;
 * - `baseline`: it was there when tracking began.
 */
export const ObservedBySchema = z.enum(["event", "rescan", "history", "baseline"])
export type ObservedBy = z.infer<typeof ObservedBySchema>

export const JournalEntrySchema = z
  .object({
    journal: JournalIdSchema,
    seq: JournalSeqSchema,
    /** When the tracker saw it. */
    at: InstantSchema,
    /** When it most likely happened: the file's modification time, or `at` for a deletion. */
    changedAt: InstantSchema,
    root: RootIdSchema,
    path: RootPathSchema,
    kind: ChangeKindSchema,
    /** A rename's old path. */
    from: RootPathSchema.optional(),
    /** The content before; null when the file didn't exist. */
    before: ContentRefSchema.nullable(),
    /** The content after; null when it no longer exists. */
    after: ContentRefSchema.nullable(),
    size: z.number().int().nonnegative().optional(),
    /** Diffed by lines; otherwise attributed whole (binary, or past the size limit). */
    text: z.boolean(),
    lines: z.object({ added: z.number().int().nonnegative(), removed: z.number().int().nonnegative() }).strict().optional(),
    /** Whether the content after is kept; never for a path that looks like it holds secrets. */
    stored: z.boolean(),
    observed: ObservedBySchema,
    /** The gap of lost events it was found in. */
    gap: z.number().int().positive().optional(),
    /** An earlier entry whose content this one brings back (an undo, a stash popped): its lines keep their authors. */
    restores: JournalSeqSchema.optional(),
    author: AttributionSchema,
    /** False while later evidence (a call's result, its reported effects) may still change the author. */
    settled: z.boolean(),
  })
  .strict()
export type JournalEntry = z.infer<typeof JournalEntrySchema>

/** A stretch where the tracker may have missed changes to a root, and why. */
export const GapSchema = z
  .object({
    id: z.number().int().positive(),
    root: RootIdSchema,
    from: InstantSchema,
    to: InstantSchema,
    reason: z.enum(["dropped", "muted", "restart", "gone"]),
  })
  .strict()
export type Gap = z.infer<typeof GapSchema>

/** A turn, a tool call or background work starting or ending in a Session. */
export const ActivityMarkSchema = z
  .object({
    kind: z.enum(["turn", "call", "background"]),
    /** The turn's, call's or work's id, unique within its Session. */
    id: z.string().min(1).max(200),
    edge: z.enum(["start", "end"]),
    at: InstantSchema,
    thread: ThreadIdSchema,
    session: SessionRefSchema,
    /** The turn a call or background work belongs to. */
    turn: z.string().min(1).max(200).optional(),
    /** The Thread's checkout: the folder its paths are in. */
    checkout: AbsolutePathSchema.optional(),
    /** The folder a call ran in. */
    cwd: AbsolutePathSchema.optional(),
    /** The tool or command, in a few words. Never file content. */
    label: z.string().max(500).optional(),
    /** Paths the call names: its target, the paths in its command line. Evidence, not a claim it wrote them. */
    named: z.array(AbsolutePathSchema).max(256).optional(),
    /**
     * Paths a command's output mentioned ("wrote ~/.config/tool/state.json").
     * Joins a path that changed outside the checkouts to the call; never a
     * claim that the call read or wrote it.
     */
    mentioned: z.array(AbsolutePathSchema).max(256).optional(),
    /** Where the harness keeps the Session's own record (its transcript file), for tracing a change back to it. */
    record: AbsolutePathSchema.optional(),
  })
  .strict()
export type ActivityMark = z.infer<typeof ActivityMarkSchema>

const Text = z.string().max(2_000_000)
/** The harness saw the file change while the call ran, rather than the tool stating it made the change; it proves timing only. */
const Seen = z.literal(true).optional()

/** What a tool call said it did, as its harness reported it. */
export const ReportedEffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), path: AbsolutePathSchema, content: Text.optional(), seen: Seen }).strict(),
  /**
   * `patch`: a unified diff of the file without its header, when the tool stated the change with line numbers;
   * `edits`: replacements in order (`old` became `new`, once or at every occurrence), when it stated text without them.
   */
  z
    .object({
      kind: z.literal("modify"),
      path: AbsolutePathSchema,
      patch: Text.optional(),
      edits: z.array(z.object({ old: Text, new: Text, all: z.literal(true).optional() }).strict()).max(256).optional(),
      seen: Seen,
    })
    .strict(),
  /** A whole-file write that doesn't say whether the file existed. */
  z.object({ kind: z.literal("write"), path: AbsolutePathSchema, content: Text.optional() }).strict(),
  z.object({ kind: z.literal("delete"), path: AbsolutePathSchema, seen: Seen }).strict(),
  z.object({ kind: z.literal("rename"), from: AbsolutePathSchema, to: AbsolutePathSchema }).strict(),
  z.object({ kind: z.literal("read"), path: AbsolutePathSchema }).strict(),
  z
    .object({
      kind: z.literal("command"),
      command: z.string().max(64_000),
      cwd: AbsolutePathSchema.optional(),
      exitCode: z.number().int().optional(),
      named: z.array(AbsolutePathSchema).max(256).optional(),
      background: z.boolean().optional(),
    })
    .strict(),
])
export type ReportedEffect = z.infer<typeof ReportedEffectSchema>

/** One tool call's reported effects. */
export const ReportedCallSchema = z
  .object({
    thread: ThreadIdSchema,
    session: SessionRefSchema,
    turn: z.string().min(1).max(200).optional(),
    call: z.string().min(1).max(200),
    startedAt: InstantSchema.optional(),
    endedAt: InstantSchema.optional(),
    /** A refused call changed nothing. */
    status: z.enum(["completed", "failed", "refused", "running"]),
    checkout: AbsolutePathSchema.optional(),
    effects: z.array(ReportedEffectSchema).max(4096),
  })
  .strict()
export type ReportedCall = z.infer<typeof ReportedCallSchema>

/**
 * A write Mako makes itself. `editor`: the person saving through Mako, so the
 * change is theirs; anything else (a Git command, a move, files carried into
 * a worktree) is Mako's.
 */
export const MakoWriteSchema = z
  .object({
    kind: z.enum(["editor", "git", "move", "carry"]),
    /** In a few words: `git stash push`. */
    operation: z.string().min(1).max(200),
    /** Files or folders it may write; a folder covers everything in it. */
    paths: z.array(AbsolutePathSchema).min(1).max(4096),
  })
  .strict()
export type MakoWrite = z.infer<typeof MakoWriteSchema>

/**
 * Why a footprint entry is the Thread's, strongest first:
 * - `writer`: the platform named the writing process, and it is one of the
 *   Thread's (fanotify on a cloud machine);
 * - `named`: one of the turn's calls named the path;
 * - `folder`: a call named a folder holding it;
 * - `output`: a command's output mentioned it;
 * - `cwd`: it is in a folder the turn ran in that no checkout holds;
 * - `window`: it only changed while the turn ran.
 */
export const FootprintBasisSchema = z.enum(["writer", "named", "folder", "output", "cwd", "window"])
export type FootprintBasis = z.infer<typeof FootprintBasisSchema>

/**
 * A path outside every tracked root that a Thread's turn read or wrote.
 * `strong`: evidence links it to the turn (`basis` says which); `weak`: it
 * only changed while the turn ran and no rule explains it away, so another
 * app or Thread could have written it.
 */
export const FootprintEntrySchema = z
  .object({
    thread: ThreadIdSchema,
    session: SessionRefSchema,
    turn: z.string().min(1).max(200).optional(),
    path: AbsolutePathSchema,
    access: z.enum(["read", "write"]),
    evidence: z.enum(["strong", "weak"]),
    basis: FootprintBasisSchema.optional(),
    at: InstantSchema,
    size: z.number().int().nonnegative().optional(),
    /** Content hash of a write, unless the path looks like it holds secrets. */
    ref: ContentRefSchema.optional(),
    /** The path looks like it holds secrets: never carried, never stored. */
    secret: z.boolean(),
  })
  .strict()
export type FootprintEntry = z.infer<typeof FootprintEntrySchema>

/** A run of consecutive lines of a file's current content by one entry; `entry` null is the base (committed) content. */
export const LineRunSchema = z
  .object({
    /** First line, from 0. */
    start: z.number().int().nonnegative(),
    length: z.number().int().positive(),
    entry: JournalSeqSchema.nullable(),
    author: AttributionSchema.nullable(),
  })
  .strict()
export type LineRun = z.infer<typeof LineRunSchema>

/* The tracker's ports: what it reads of the machine. A conformance run passes fakes. */

export interface TrackerFileStat {
  kind: "file" | "directory" | "symlink" | "other"
  dev: number
  ino: number
  size: number
  mode: number
  mtimeNs: bigint
  ctimeNs: bigint
}

export interface TrackerFileSystem {
  /** Null when nothing is there. Never follows a symlink. */
  stat(path: string): Promise<TrackerFileStat | null>
  /** The whole file; null when it's gone. */
  read(path: string): Promise<Uint8Array | null>
  /** The file in pieces, for one too large to read whole; a file system without it is read whole. */
  stream?(path: string): AsyncIterable<Uint8Array>
  /** Every file under `root` as paths relative to it, skipping folders `skip` names: a rescan's walk. */
  walk(root: string, skip: (path: RootPath) => boolean): Promise<RootPath[]>
}

export type LossReason = "dropped" | "muted" | "gone"

export interface TrackerChangeListener {
  /** Paths relative to the root that may have changed. */
  changed(paths: readonly string[]): void
  /** Events were or may be lost; `muted` ends when `heard` says delivery is back. */
  lost(reason: LossReason): void
  heard(): void
}

export interface TrackerEventSource {
  watch(root: string, listener: TrackerChangeListener): Promise<{ close(): void }>
  /** Where the system's history of changes stands; null where it keeps none. */
  mark(): Promise<string | null>
  /**
   * Paths under `root` changed after `mark`; null when the history can't say.
   * `complete` false: some were lost. Paths in or under an `ignore` folder
   * are left out where the history is read and counted in `ignored`, one
   * count per folder, so a busy machine's churn never crosses to the
   * tracker. `writers` names the processes that wrote a path, where the
   * platform reports them (fanotify); FSEvents names none.
   */
  since(mark: string, root: string, options?: { ignore?: readonly string[] }): Promise<HistorySince | null>
}

export interface HistorySince {
  paths: string[]
  complete: boolean
  /** Per `ignore` folder, in its order: the paths left out under it. */
  ignored?: number[]
  writers?: ReadonlyMap<string, readonly number[]>
}

/** Which Session's process tree a process is in, where the platform names a change's writer. */
export interface TrackerProcesses {
  session(pid: number): string | undefined
}

export interface TrackerClock {
  /** Epoch milliseconds, in the same clock as the file system's times. */
  now(): number
}

export interface TrackerPorts {
  fs: TrackerFileSystem
  events: TrackerEventSource
  clock: TrackerClock
  /** A folder the tracker owns for its journal; a tracker opened again on it resumes the same journal. */
  storage: string
  /** The device's id, recorded in the journal. */
  device: string
  /** The process trees of the Sessions, where `since` names writers. */
  processes?: TrackerProcesses
}

/** A write Mako is making; `end` once it has. */
export interface MakoWriting {
  end(): void
}

/** Everything a tracker does, on any device. */
export interface AttributionTracker {
  readonly journal: JournalId
  /** Start, or resume, tracking a root. Its contents when tracking began are the base. */
  track(root: TrackedRoot): Promise<void>
  untrack(root: RootId): Promise<void>
  activity(mark: ActivityMark): void
  reported(call: ReportedCall): void
  /** Mako is about to write; `end` once it has. */
  mako(write: MakoWrite): MakoWriting
  /** Settles once every change heard so far is in the journal. */
  settled(): Promise<void>
  /** Entries after `after`, in order. */
  changes(after: number, limit?: number): JournalEntry[]
  /** The current content's lines by entry; null for a file not tracked or not text. */
  blame(root: RootId, path: RootPath): LineRun[] | null
  footprint(thread: string): FootprintEntry[]
  gaps(): Gap[]
  /** Whether the content behind `ref` is kept. */
  stored(ref: ContentRef): boolean
  close(): Promise<void>
}

/** Strongest first, so a smaller rank is surer. `mako` is exact about Mako's own writes. */
export function certaintyRank(certainty: Certainty): number {
  return certainty === "mako" ? 0 : CERTAINTIES.indexOf(certainty)
}
