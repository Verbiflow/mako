import type { Attribution, Certainty, ContentRef, FootprintEntry } from "@mako/protocol"
import { TURN_CHANGES_VERSION, type TurnChangedFile, type TurnChangeLines, type TurnChanges, type TurnChangeShare } from "../contracts/turn-changes.js"
import { decodeText } from "./content.js"
import { wholeChange, type FileState, type JournalStore, type StatRow, type StoredEntry, type StoredRoot } from "./journal-store.js"
import { diffLines, splitLines } from "./line-diff.js"
import { BASE, type Run } from "./line-map.js"
import { within } from "./paths.js"

/*
 * What the journal answers, as functions of what it holds: who wrote each
 * line, each hunk of a checkout's diff and by whom, what a Thread changed,
 * and how a checkout's changes divide between one Thread and everyone else.
 * The Thread is the only author these answer for; a Session is kept on an
 * entry as metadata. Every function reads a `JournalView`, which the live
 * tracker and a read-only journal both provide.
 */

export interface RootView {
  root: StoredRoot
  files: ReadonlyMap<string, FileState>
  stats?: ReadonlyMap<string, StatRow>
}

export interface JournalView {
  store: JournalStore
  roots(): Iterable<RootView>
  /** An entry's author as it stands, including one not yet settled. */
  author(seq: number): Attribution | null
}

/** A read-only view of a journal no tracker is running. */
export function storedView(store: JournalStore): JournalView {
  const files = store.files()
  const authors = new Map<number, Attribution | null>()
  return {
    store,
    roots: () => store.roots().filter((root) => root.active).map((root) => ({ root, files: new Map(files.filter((file) => file.root === root.id).map((file) => [file.path, file])) })),
    author: (seq) => {
      if (!authors.has(seq)) authors.set(seq, store.author(seq) ?? null)
      return authors.get(seq) ?? null
    },
  }
}

/** Where a change stands with respect to one Thread: its own, possibly its own, or not. */
export type Side = "thread" | "uncertain" | "other"

/**
 * `exact` and `named` put a change on a Thread. So does `window` when it
 * happened while a call or background work of that Thread's that may write
 * was the only thing running in the checkout, on a file its work had
 * reached: every uncommitted change is the person's or an agent's, and
 * that's the agent's, which a move takes and says so (`likely`). A `window`
 * only its turn spans, heard only after the call ended, of work that runs on
 * its own (a dev server, a call minutes in), or on a file the Thread never
 * went near, and `ambiguous`, only say it might be.
 */
export function side(author: Attribution | null, thread: string): Side {
  if (!author) return "other"
  switch (author.certainty) {
    case "exact":
    case "named":
      return author.author.thread === thread ? "thread" : "other"
    case "window":
      return author.author.thread !== thread ? "other" : likely(author, thread) ? "thread" : "uncertain"
    case "ambiguous":
      return author.candidates.some((candidate) => candidate.thread === thread) ? "uncertain" : "other"
    case "person":
    case "mako":
      return "other"
  }
}

/** The Thread's on timing alone: a move takes it, lists it, and can put it back. */
export function likely(author: Attribution | null, thread: string): boolean {
  return author?.certainty === "window" && author.author.thread === thread && author.during !== "turn" && !author.trailing && !author.standing && author.reached !== undefined
}

/** Nobody can be named for it: it was there when tracking began, or found after lost events with nothing running. */
export function unattributed(author: Attribution | null): boolean {
  return author?.certainty === "ambiguous" && author.candidates.length === 0
}

/**
 * Whose a change is, as a move reports it: the Thread's, another Thread's,
 * the person's (Mako's own writes are made for the person), one that might
 * be the Thread's, or one nobody can be named for.
 */
export type ChangeClass = "thread" | "others" | "person" | "uncertain" | "unattributed"

export function classOf(author: Attribution | null, thread: string): ChangeClass {
  const at = side(author, thread)
  if (at !== "other") return at
  if (unattributed(author)) return "unattributed"
  return author && "author" in author ? "others" : "person"
}

/** Who wrote something, in a word: a Thread and how sure, or the base. */
export interface Writer {
  thread?: string
  certainty: Certainty | "base"
}

/** Who an author is, in a word, for hunks and the debugging script. */
export function writerOf(author: Attribution | null): Writer {
  if (!author) return { certainty: "base" } satisfies Writer
  return "author" in author ? { thread: author.author.thread, certainty: author.certainty } : { certainty: author.certainty }
}

const rootsIn = (view: JournalView, checkout: string) => [...view.roots()].filter((root) => within(checkout, root.root.path) || within(root.root.path, checkout))

function linesOf(view: JournalView, ref: ContentRef | null): string[] | undefined {
  if (!ref) return []
  const bytes = view.store.blob(ref)
  return bytes ? splitLines(decodeText(bytes)) : undefined
}

/** A stretch of the diff against the base: base lines removed, current lines in their place. */
interface Region {
  /** Runs of the map in the region, in order. */
  runs: Run[]
  base: { start: number; length: number }
  current: { start: number; length: number }
}

/** The map's changed stretches: runs that aren't unchanged base lines, between ones that are. */
function regions(map: readonly Run[]): Region[] {
  const out: Region[] = []
  let current = 0
  let base = 0
  let open: Region | undefined
  for (const run of map) {
    const unchanged = run.ins === BASE && !run.del
    if (unchanged) {
      open = undefined
      current += run.length
      base = run.origin + run.length
      continue
    }
    if (!open) out.push((open = { runs: [], base: { start: base, length: 0 }, current: { start: current, length: 0 } }))
    open.runs.push(run)
    if (run.del) {
      open.base.length += run.length
      base = run.origin + run.length
    } else {
      open.current.length += run.length
      current += run.length
    }
  }
  return out
}

export interface CheckoutHunk {
  root: string
  path: string
  /** A whole file created, deleted or renamed, or lines changed in place. */
  kind: "lines" | "create" | "delete" | "binary"
  base: { start: number; length: number }
  current: { start: number; length: number }
  /** Every last writer in the hunk: of its new lines, and of the base lines it removed. */
  writers: { entry: number; thread?: string; certainty: Certainty | "base" }[]
}

/** The checkout's diff against its base, hunk by hunk, each with its last writers. */
export function hunks(view: JournalView, checkout: string): CheckoutHunk[] {
  const out: CheckoutHunk[] = []
  for (const { root, files } of rootsIn(view, checkout)) {
    for (const file of [...files.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      const writer = (seq: number) => ({ entry: seq, ...writerOf(seq > 0 ? view.author(seq) : null) })
      const last = lastEntry(view, file)
      if (file.base === null || file.current === null || !file.text) {
        const kind = file.base === null ? "create" : file.current === null ? "delete" : "binary"
        out.push({ root: root.id, path: file.path, kind, base: { start: 0, length: 0 }, current: { start: 0, length: 0 }, writers: last ? [writer(last.seq)] : [] })
        continue
      }
      for (const region of regions(file.map)) {
        const seqs = new Set(region.runs.map((run) => (run.del ? run.del : run.ins)))
        out.push({ root: root.id, path: file.path, kind: "lines", base: region.base, current: region.current, writers: [...seqs].map(writer) })
      }
    }
  }
  return out
}

/** Who made the file what it is now. A file created, deleted or binary that a commit left out keeps its writer from before the base moved. */
function lastEntry(view: JournalView, file: FileState): StoredEntry | undefined {
  return view.store.last(file.root, file.path, wholeChange(file) ? 0 : file.baseSeq)
}

/** Old paths of files renamed since their base, to their new paths. */
function renames(view: JournalView, files: ReadonlyMap<string, FileState>): Map<string, string> {
  const out = new Map<string, string>()
  for (const file of files.values()) {
    if (file.current !== null) continue
    const last = lastEntry(view, file)
    if (last?.kind === "rename" && last.from === file.path && files.get(last.path)?.base === null) out.set(file.path, last.path)
  }
  return out
}

/** What a Thread's side or the checkout's side holds of one file. */
export type FileVersion =
  | { kind: "absent" }
  | { kind: "text"; text: string }
  /** Whole content by address: in the journal when it's kept, else on disk at `path` (absolute). */
  | { kind: "content"; ref: ContentRef; path?: string }

export interface PartitionFile {
  root: string
  /** Relative to its root. */
  path: string
  /** The Thread's changes leave as the whole file (created, deleted, renamed, binary), or as some of its lines. */
  move: "whole" | "lines"
  /** What the journal holds as the file's content now, which a move checks against the disk before it writes. */
  current: ContentRef | null
  /** Base plus the Thread's last-writer lines: what its worktree or its departure commit gets. */
  thread: FileVersion
  /** Everything else: what the checkout keeps once the Thread's lines are out. */
  remaining: FileVersion
}

/** A hunk whose lines couldn't be divided, given whole to whoever last wrote most of it. */
export interface WholeHunk {
  root: string
  path: string
  base: { start: number; length: number }
  current: { start: number; length: number }
  to: "thread" | "checkout"
  reason: "line-restored-by-another-writer"
}

/** Lines the Thread might have written (a `window` only its turn spans, `ambiguous`): they stay, and a move can offer them. */
export interface UncertainChange {
  root: string
  path: string
  /** Lines of the current content, or the whole file. */
  lines?: { start: number; length: number }
  entry: number
  certainty: Certainty
}

export interface Partition {
  checkout: string
  thread: string
  /** Each repository or folder of the checkout, with the commit its base is. */
  roots: { root: string; path: string; head: string | null }[]
  files: PartitionFile[]
  whole: WholeHunk[]
  uncertain: UncertainChange[]
  /** Lines nobody can be named for (`unattributed`): they stay unless brought. */
  unattributed: UncertainChange[]
  ms: number
}

export interface PartitionOptions {
  /** Take the lines that might be the Thread's and those nobody can be named for too, as a person's "Bring these" does. */
  bring?: boolean
}

/**
 * How a checkout's uncommitted changes divide for a move: each current line
 * belongs to its last writer. Lines the Thread last wrote go with it at
 * their latest content; everything else stays. A hunk with several last
 * writers splits by line, except where splitting can't give a valid file
 * (a writer put back a base line another removed): that hunk goes whole to
 * whoever last wrote most of it, and is listed in `whole`. Created, deleted, renamed and binary files go
 * whole to their last writer. A `window` only the Thread's turn spans, and
 * `ambiguous` lines, stay and are listed in `uncertain`.
 */
export function partition(view: JournalView, checkout: string, thread: string, options: PartitionOptions = {}): Partition {
  const started = performance.now()
  const result: Partition = { checkout, thread, roots: [], files: [], whole: [], uncertain: [], unattributed: [], ms: 0 }
  const sides = new Map<number, Side>()
  // Lines nobody can be named for stay beside the uncertain ones, and a person's "Bring these" takes both.
  const sideOf = (seq: number): Side => {
    if (seq <= 0) return "other"
    let found = sides.get(seq)
    if (!found) {
      const author = view.author(seq)
      found = side(author, thread)
      if (found === "other" && unattributed(author)) found = "uncertain"
      if (found === "uncertain" && options.bring) found = "thread"
      sides.set(seq, found)
    }
    return found
  }
  const stays = (root: string, path: string, entry: number, lines?: { start: number; length: number }) => {
    const author = view.author(entry)!
    const change: UncertainChange = lines ? { root, path, lines, entry, certainty: author.certainty } : { root, path, entry, certainty: author.certainty }
    ;(unattributed(author) ? result.unattributed : result.uncertain).push(change)
  }
  for (const { root, files } of rootsIn(view, checkout)) {
    result.roots.push({ root: root.id, path: root.path, head: root.head })
    // A rename's old path goes or stays with its new one, so neither side keeps the file twice or loses it.
    const renamedTo = renames(view, files)
    const wholeSide = (file: FileState) => {
      const to = renamedTo.get(file.path)
      const last = lastEntry(view, to ? files.get(to)! : file)
      return last && { seq: last.seq, side: sideOf(last.seq) }
    }
    for (const file of files.values()) {
      const absolute = `${root.path}/${file.path}`
      const content = (ref: ContentRef | null): FileVersion => (ref ? { kind: "content", ref, path: view.store.hasBlob(ref) ? undefined : absolute } : { kind: "absent" })
      if (file.base === null || file.current === null || !file.text) {
        const last = wholeSide(file)
        if (!last) continue
        if (last.side === "uncertain") stays(root.id, file.path, last.seq)
        if (last.side !== "thread") continue
        result.files.push({ root: root.id, path: file.path, move: "whole", current: file.current, thread: content(file.current), remaining: content(file.base) })
        continue
      }
      const split = splitFile(view, file, sideOf)
      if (!split) continue
      for (const lines of split.uncertain) stays(root.id, file.path, lines.entry, lines.lines)
      for (const hunk of split.whole) result.whole.push({ root: root.id, path: file.path, ...hunk })
      if (!split.moves) continue
      result.files.push({ root: root.id, path: file.path, move: "lines", current: file.current, thread: { kind: "text", text: split.thread }, remaining: { kind: "text", text: split.remaining } })
    }
  }
  result.files.sort((a, b) => a.root.localeCompare(b.root) || a.path.localeCompare(b.path))
  result.ms = performance.now() - started
  return result
}

/** One text file's two sides, line by line; undefined when its content isn't kept. */
function splitFile(view: JournalView, file: FileState, sideOf: (seq: number) => Side) {
  const changed = regions(file.map)
  if (!changed.length) return undefined
  const touches = changed.some((region) => region.runs.some((run) => sideOf(run.del || run.ins) !== "other"))
  if (!touches) return undefined
  const base = linesOf(view, file.base)
  const current = linesOf(view, file.current)
  if (!base || !current) return undefined
  const thread: string[] = []
  const remaining: string[] = []
  const whole: Omit<WholeHunk, "root" | "path">[] = []
  const uncertain: { lines: { start: number; length: number }; entry: number }[] = []
  let moves = false
  let line = 0
  /** Lines of the region, each with its text and last writer's side, in order. */
  const linesIn = (region: Region) => {
    const out: { text: string; side: Side; dead: boolean }[] = []
    let at = region.current.start
    for (const run of region.runs) {
      for (let i = 0; i < run.length; i++) {
        if (run.del) out.push({ text: base[run.origin + i] ?? "", side: sideOf(run.del), dead: true })
        else out.push({ text: current[at++] ?? "", side: sideOf(run.ins), dead: false })
      }
      if (!run.del && sideOf(run.ins) === "uncertain") uncertain.push({ lines: { start: at - run.length, length: run.length }, entry: run.ins })
    }
    return out
  }
  for (const region of changed) {
    // Unchanged lines before the region are on both sides.
    for (; line < region.current.start; line++) {
      thread.push(current[line]!)
      remaining.push(current[line]!)
    }
    const lines = linesIn(region)
    const mine = (item: { side: Side }) => item.side === "thread"
    const reason = unsafe(lines)
    if (reason) {
      const ours = lines.filter(mine).length
      const to = ours * 2 > lines.length ? "thread" : "checkout"
      if (lines.some(mine)) whole.push({ base: region.base, current: region.current, to, reason })
      for (const item of lines) {
        // Whole: the winner's side gets the region as it is now, the other the region as the base had it.
        if (to === "thread") (item.dead ? remaining : thread).push(item.text)
        else (item.dead ? thread : remaining).push(item.text)
      }
      if (to === "thread") moves = true
    } else {
      for (const item of lines) {
        if (item.dead) (mine(item) ? remaining : thread).push(item.text)
        else (mine(item) ? thread : remaining).push(item.text)
        if (mine(item)) moves = true
      }
    }
    line = region.current.start + region.current.length
  }
  for (; line < current.length; line++) {
    thread.push(current[line]!)
    remaining.push(current[line]!)
  }
  return { thread: thread.join(""), remaining: remaining.join(""), moves, whole, uncertain }
}

/**
 * Why a region can't be split line by line, if it can't: a writer put back
 * a base line another removed, so the checkout's side would hold it twice.
 * (Lines that replaced another writer's are simply theirs: the map makes
 * whoever removed a run of lines the last writer of the base lines under
 * it.)
 */
function unsafe(lines: readonly { text: string; side: Side; dead: boolean }[]): WholeHunk["reason"] | undefined {
  const mixed = (a: Side, b: Side) => a !== b && (a === "thread" || b === "thread")
  const removed = new Map<string, Set<Side>>()
  for (const item of lines) if (item.dead) removed.set(item.text, (removed.get(item.text) ?? new Set()).add(item.side))
  for (const item of lines) {
    if (item.dead) continue
    for (const by of removed.get(item.text) ?? []) if (mixed(by, item.side)) return "line-restored-by-another-writer"
  }
  return undefined
}

/** Changed files and lines of one class: lines added plus base lines removed. */
export interface Share {
  /** Absolute paths. */
  files: string[]
  lines: number
}

/** A checkout's changes by `ChangeClass`. */
export interface CheckoutShares {
  thread: Share
  /** Of the Thread's, what only timing names (`likely`): a move takes it and lists it. */
  likely: Share
  others: Share
  person: Share
  uncertain: Share
  unattributed: Share
}

/**
 * How a checkout's uncommitted changes divide by whose they are, for one
 * Thread: what a move would take, and what would stay and why. A whole file
 * (created, deleted, renamed, binary) is its last writer's; a file of lines
 * counts in each class that last wrote some of them.
 */
export function shares(view: JournalView, checkout: string, thread: string): CheckoutShares {
  const out: CheckoutShares = { thread: share(), likely: share(), others: share(), person: share(), uncertain: share(), unattributed: share() }
  const classes = new Map<number, ChangeClass | "likely">()
  /** A change's class, with the Thread's on timing alone told apart; they count as the Thread's too. */
  const classAt = (seq: number): ChangeClass | "likely" => {
    let found = classes.get(seq)
    if (!found) {
      const author = seq > 0 ? view.author(seq) : null
      classes.set(seq, (found = likely(author, thread) ? "likely" : classOf(author, thread)))
    }
    return found
  }
  for (const { root, files } of rootsIn(view, checkout)) {
    // A renamed file's lines are counted at its new path, which keeps their writers.
    const renamed = renames(view, files)
    for (const file of files.values()) {
      const path = `${root.path}/${file.path}`
      const counted = new Map<ChangeClass | "likely", number>()
      if (file.base === null || file.current === null || !file.text) {
        const last = lastEntry(view, file)
        if (last) counted.set(classAt(last.seq), file.text && !renamed.has(file.path) ? file.map.reduce((sum, run) => sum + (run.ins !== BASE || run.del ? run.length : 0), 0) : 0)
      } else {
        for (const region of regions(file.map))
          for (const run of region.runs) {
            const at = classAt(run.del || run.ins)
            counted.set(at, (counted.get(at) ?? 0) + run.length)
          }
      }
      for (const [at, lines] of counted) {
        out[at].files.push(path)
        out[at].lines += lines
      }
      const likelyLines = counted.get("likely")
      if (likelyLines !== undefined) {
        if (!counted.has("thread")) out.thread.files.push(path)
        out.thread.lines += likelyLines
      }
    }
  }
  return out
}

const share = (): Share => ({ files: [], lines: 0 })

export interface ThreadChanges {
  thread: string
  /** Files by what happened to them, each counted once at its latest change. */
  files: { created: string[]; modified: string[]; deleted: string[]; renamed: { from: string; to: string }[] }
  lines: { added: number; removed: number }
  /** Commands its calls ran, as their harness reported them, the newest last. */
  commands: { command: string; cwd?: string; exitCode?: number; at: number }[]
  /** Paths outside its checkout it read or wrote. */
  outside: FootprintEntry[]
  /** Entries by certainty: how much of this is sure. */
  certainty: Partial<Record<Certainty, number>>
  /** Entries that might be this Thread's: a `window` only its turn spans, or `ambiguous` with it among the candidates. */
  maybe: number
}

/** What a Thread changed for sure, entry by entry: files, lines, commands and paths outside its checkout, with how sure each is. */
export function changes(view: JournalView, thread: string): ThreadChanges {
  const entries = view.store.entriesBy("thread", thread)
  const result: ThreadChanges = {
    thread,
    files: { created: [], modified: [], deleted: [], renamed: [] },
    lines: { added: 0, removed: 0 },
    commands: [],
    outside: view.store.footprint("thread", thread),
    certainty: {},
    maybe: 0,
  }
  const roots = new Map([...view.store.roots()].map((root) => [root.id, root.path]))
  const latest = new Map<string, StoredEntry>()
  const first = new Map<string, StoredEntry>()
  let uncertain = 0
  for (const entry of entries) {
    result.certainty[entry.author.certainty] = (result.certainty[entry.author.certainty] ?? 0) + 1
    // Only its own: a window only its turn spans is a maybe, as an ambiguous change naming it is.
    if (side(view.author(entry.seq), thread) !== "thread") {
      uncertain++
      continue
    }
    result.lines.added += entry.added ?? 0
    result.lines.removed += entry.removed ?? 0
    const key = `${roots.get(entry.root) ?? entry.root}/${entry.path}`
    if (!first.has(key)) first.set(key, entry)
    latest.set(key, entry)
  }
  for (const [path, entry] of latest) {
    const began = first.get(path)!
    if (entry.kind === "delete") {
      if (began.kind !== "create") result.files.deleted.push(path)
    } else if (entry.kind === "rename") result.files.renamed.push({ from: `${roots.get(entry.root) ?? entry.root}/${entry.from}`, to: path })
    else if (began.kind === "create") result.files.created.push(path)
    else result.files.modified.push(path)
  }
  for (const activity of view.store.activityOfThread(thread))
    for (const effect of activity.effects ?? [])
      if (effect.kind === "command") result.commands.push({ command: effect.command, cwd: effect.cwd, exitCode: effect.exitCode, at: activity.start })
  result.maybe = uncertain + view.store.ambiguousWith(thread)
  return result
}

export interface Restorable {
  root: string
  path: string
  entry: number
  at: number
  ref: ContentRef
  size?: number
  author: Attribution
}

/**
 * Versions the journal still keeps, newest first: of one file, or the last
 * each file had from one Thread. Work a `git checkout -- .`, a hard reset or
 * a dropped stash destroyed is behind no uncommitted line any more, so only
 * the retention window keeps it.
 */
export function restorable(view: JournalView, target: { root: string; path: string } | { thread: string }): Restorable[] {
  const entries = "thread" in target ? view.store.entriesBy("thread", target.thread) : view.store.chain(target.root, target.path)
  const out: Restorable[] = []
  const seen = new Set<string>()
  for (const entry of entries.reverse()) {
    if (!entry.after || !view.store.hasBlob(entry.after)) continue
    if ("thread" in target) {
      if (side(entry.author, target.thread) !== "thread") continue
      const key = `${entry.root}\u0000${entry.path}`
      if (seen.has(key)) continue
      seen.add(key)
    }
    out.push({ root: entry.root, path: entry.path, entry: entry.seq, at: entry.at, ref: entry.after, size: entry.size, author: entry.author })
  }
  return out
}

/** Files a turn's summary lists, at most; the rest are counted (`more`). */
export const TURN_FILES = 500

/** Whose a line is in a turn's count: the Thread's, possibly its, someone else's, or there before the turn. */
type Tag = "own" | "maybe" | "other" | "pre"

/** One file's net change over a turn, line by line: who added the lines there now, and who removed the lines that were there. */
interface FileCount {
  own: { added: number; removed: number }
  maybe: { added: number; removed: number }
}

/**
 * The lines of one file across a stretch of its entries, each tagged with
 * whoever last wrote it in the stretch; undefined when some version's
 * content isn't kept. Each entry's change is the journal's own line diff of
 * its two sides, so the count agrees with the line maps.
 */
function countLines(view: JournalView, chain: readonly StoredEntry[], tagOf: (seq: number) => Tag): FileCount | undefined {
  const count: FileCount = { own: { added: 0, removed: 0 }, maybe: { added: 0, removed: 0 } }
  let lines: string[] = []
  let tags: Tag[] = []
  let at: ContentRef | null | undefined
  /** Lines of `next` in place of the current ones, written by `by`. */
  const apply = (next: string[], by: Tag) => {
    const out: Tag[] = []
    let from = 0
    for (const hunk of diffLines(lines, next)) {
      for (; from < hunk.a; from++) out.push(tags[from]!)
      for (let i = 0; i < hunk.removed; i++, from++) if (tags[from] === "pre" && (by === "own" || by === "maybe")) count[by].removed++
      // A line there before the turn that someone else removes stays theirs; one the turn wrote and took back counts for nobody.
      for (let i = 0; i < hunk.added; i++) out.push(by)
    }
    for (; from < lines.length; from++) out.push(tags[from]!)
    lines = next
    tags = out
  }
  for (const [index, entry] of chain.entries()) {
    if (!entry.text && (entry.before !== null || entry.after !== null)) return undefined
    if (index === 0) {
      const first = linesOf(view, entry.before)
      if (!first) return undefined
      lines = first
      tags = first.map(() => "pre")
    } else if (entry.before !== at) {
      // Something between two entries the journal kept apart: whoever it was, it wasn't the turn.
      const between = linesOf(view, entry.before)
      if (!between) return undefined
      apply(between, "other")
    }
    const after = linesOf(view, entry.after)
    if (!after) return undefined
    apply(after, tagOf(entry.seq))
    at = entry.after
  }
  for (const tag of tags) if (tag === "own" || tag === "maybe") count[tag].added++
  return count
}

/**
 * What a Thread's turn changed, counted from the journal: each file the
 * turn's entries touched, from the content before its first entry on it to
 * the content after its last, every line counted for whoever wrote it last
 * in between (`TurnChanges`). The turn's entries are the Thread's in that
 * turn and the ambiguous ones naming it with that turn; `others` counts
 * the rest of the checkout's entries while the turn ran.
 */
export function turnChanges(view: JournalView, thread: string, turn: string, state: TurnChanges["state"] = "settled", now = Date.now()): TurnChanges {
  const store = view.store
  const roots = new Map(store.roots().map((root) => [root.id, root.path]))
  const tags = new Map<number, Tag>()
  const entries: StoredEntry[] = []
  for (const entry of store.entriesOfTurn(thread, turn)) {
    const at = side(view.author(entry.seq), thread)
    if (at === "other") continue
    tags.set(entry.seq, at === "thread" ? "own" : "maybe")
    entries.push(entry)
  }
  // The turn's entries by file, a rename carrying the file's earlier entries to its new path.
  const groups = new Map<string, TurnFile>()
  for (const entry of entries) {
    const from = entry.kind === "rename" ? entry.from : undefined
    const moved = from !== undefined ? groups.get(`${entry.root}\u0000${from}`) : undefined
    if (moved) groups.delete(`${entry.root}\u0000${from}`)
    const key = `${entry.root}\u0000${entry.path}`
    const group = moved ?? groups.get(key) ?? { root: entry.root, path: entry.path, was: from ?? entry.path, paths: new Set([entry.path]), first: entry.seq, last: entry.seq, seqs: [] }
    group.path = entry.path
    group.paths.add(entry.path)
    if (from !== undefined) group.paths.add(from)
    group.last = entry.seq
    group.seqs.push(entry.seq)
    groups.set(key, group)
  }
  const tagOf = (seq: number): Tag => tags.get(seq) ?? "other"
  const counted: TurnChangedFile[] = []
  for (const group of groups.values()) {
    const file = countFile(view, group, tagOf, roots.get(group.root) ?? group.root)
    if (file) counted.push(file)
  }
  counted.sort((a, b) => a.path.localeCompare(b.path))
  const share = (pick: (file: TurnChangedFile) => TurnChangeLines | null | undefined): TurnChangeShare => {
    const out = { files: 0, added: 0, removed: 0 }
    for (const file of counted) {
      const lines = pick(file)
      if (lines === undefined) continue
      out.files++
      out.added += lines?.added ?? 0
      out.removed += lines?.removed ?? 0
    }
    return out
  }
  return {
    version: TURN_CHANGES_VERSION,
    state,
    thread,
    turn,
    own: share((file) => file.own),
    maybe: share((file) => file.maybe),
    others: othersDuring(view, thread, turn, tags),
    files: counted.slice(0, TURN_FILES),
    more: Math.max(0, counted.length - TURN_FILES),
    journal: store.id,
    through: store.lastSeq(),
    at: now,
  }
}

/** One file's entries in a turn: where it is after them, where it was before, and the entries that span it. */
interface TurnFile {
  root: string
  path: string
  was: string
  /** Every path its entries were at, to read its chain under each. */
  paths: Set<string>
  first: number
  last: number
  seqs: number[]
}

/** One file of a turn, counted; undefined when the turn made it and took it away again, or none of it is the Thread's. */
function countFile(view: JournalView, group: TurnFile, tagOf: (seq: number) => Tag, base: string): TurnChangedFile | undefined {
  // Every entry on the file from the turn's first to its last, others' among them.
  const chain = [...new Map([...group.paths].flatMap((path) => view.store.chain(group.root, path, group.first - 1)).filter((entry) => entry.seq <= group.last).map((entry) => [entry.seq, entry])).values()]
    .sort((a, b) => a.seq - b.seq)
  const first = chain[0]
  const last = chain.at(-1)
  if (!first || !last || (first.before === null && last.after === null)) return undefined
  const renamed = group.was !== group.path
  const kind: TurnChangedFile["kind"] = first.before === null ? "create" : last.after === null ? "delete" : renamed ? "rename" : "modify"
  const lines = countLines(view, chain, tagOf)
  // A whole-file change is its maker's: the entry that created, deleted or renamed it.
  const maker = kind === "create" ? first : kind === "delete" ? last : kind === "rename" ? chain.find((entry) => entry.kind === "rename") : undefined
  const madeBy = maker && tagOf(maker.seq)
  const has = (tag: "own" | "maybe") => (lines ? lines[tag].added + lines[tag].removed > 0 || madeBy === tag : group.seqs.some((seq) => tagOf(seq) === tag))
  const owns = has("own")
  const maybes = has("maybe")
  if (!owns && !maybes) return undefined
  return {
    path: `${base}/${group.path}`,
    root: group.root,
    relative: group.path,
    kind,
    ...(renamed && { from: `${base}/${group.was}` }),
    ...(owns && { own: lines ? lines.own : null }),
    ...(maybes && { maybe: lines ? lines.maybe : null }),
    before: first.before,
    after: last.after,
    entries: { first: group.first, last: group.last },
  }
}

/** What others changed in the turn's checkout while it ran: files and lines as each entry stated them, never the Thread's. */
function othersDuring(view: JournalView, thread: string, turn: string, tags: ReadonlyMap<number, Tag>): TurnChangeShare {
  const span = view.store.turn(thread, turn)
  const out = { files: 0, added: 0, removed: 0 }
  if (!span?.checkout) return out
  const inside = new Set(rootsIn(view, span.checkout).map((root) => root.root.id))
  const files = new Set<string>()
  for (const entry of view.store.entriesBetween(span.start, span.end ?? Number.MAX_SAFE_INTEGER)) {
    if (!inside.has(entry.root) || tags.has(entry.seq) || entry.author.certainty === "mako") continue
    if ("author" in entry.author && entry.author.author.thread === thread) continue
    files.add(`${entry.root}\u0000${entry.path}`)
    out.added += entry.added ?? 0
    out.removed += entry.removed ?? 0
  }
  out.files = files.size
  return out
}
