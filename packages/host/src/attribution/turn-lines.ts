import { createHash } from "node:crypto"
import { relative } from "node:path"
import type { ContentRef } from "@mako/protocol"
import type { TurnChangedFile } from "../contracts/turn-changes.js"
import type { KeptLines, TurnUndoFile, TurnUndoKept, TurnUndoLeft, TurnUndoScope, TurnWriter, WriterRun } from "../contracts/turn-review.js"
import type { StoredEntry } from "./journal-store.js"
import { diffLines } from "./line-diff.js"
import { original, present, walkLines, type Walk, type WalkedLine } from "./line-walk.js"
import { classOf, fileGroups, linesOf, rootsIn, side, turnChain, type JournalView, type TurnFile } from "./queries.js"

/*
 * A turn's lines, read from the journal for its review and its undo. Both
 * walk the file's entries with `walkLines`, the walk `turnChanges` counts
 * with, so the lines the review marks as the turn's are the lines its
 * record counts, and the lines an undo takes out are those.
 */

/** Who wrote a line, as a turn's review names them, and which Thread for another's. */
export interface Hand {
  writer: TurnWriter
  thread?: string
}

const UNKNOWN: Hand = { writer: "unknown" }

/** A turn's own entries: the Thread's in that turn, and the ambiguous ones naming it there (`turnChanges`). */
function turnEntries(view: JournalView, thread: string, turn: string): StoredEntry[] {
  return view.store.entriesOfTurn(thread, turn).filter((entry) => side(view.author(entry.seq), thread) !== "other")
}

/**
 * How an entry's writer reads beside a scope: `turn` for the scope's own, by
 * the Thread for sure, the rest by `side` as a rewind's writers read them
 * (`writersSince`). What Git or Mako itself wrote is nobody's: an undo never
 * takes it back.
 */
function handOf(view: JournalView, thread: string, scope: ReadonlySet<number>, entry: StoredEntry): Hand {
  const author = view.author(entry.seq)
  if (entry.git || author?.certainty === "mako") return UNKNOWN
  if (scope.has(entry.seq)) return { writer: side(author, thread) === "thread" ? "turn" : "maybe" }
  switch (classOf(author, thread)) {
    case "thread":
      return { writer: "thread" }
    case "uncertain":
      return { writer: "maybe" }
    case "others":
      return author && "author" in author ? { writer: "other", thread: author.author.thread } : { writer: "other" }
    case "person":
      return { writer: "person" }
    case "unattributed":
      return UNKNOWN
  }
}

/** A record's file as the journal groups it: its root, the paths it was at, and the turn's entries that span it. */
function recordGroup(file: TurnChangedFile): Pick<TurnFile, "root" | "paths" | "first" | "last"> {
  const base = file.path.slice(0, file.path.length - file.relative.length - 1)
  const was = file.from?.startsWith(`${base}/`) ? file.from.slice(base.length + 1) : file.relative
  return { root: file.root, paths: new Set([file.relative, was]), first: file.entries.first, last: file.entries.last }
}

/**
 * One file of a turn, walked from before the turn's first entry on it to
 * after its last; with `fromStart`, from the turn's own start instead, so a
 * save of someone else's on the file after the turn began and before the
 * turn first wrote it is walked too, and named theirs. The turn's
 * checkpoints, which its review draws when both were saved, hold that save.
 */
function walkTurnFile(view: JournalView, thread: string, turn: string, file: TurnChangedFile, fromStart = false): Walk<Hand> | undefined {
  const scope = new Set(turnEntries(view, thread, turn).map((entry) => entry.seq))
  const group = recordGroup(file)
  const began = fromStart ? view.store.turn(thread, turn)?.start : undefined
  if (began !== undefined) {
    const earlier = view.store.entriesBetween(began, Number.MAX_SAFE_INTEGER).find((entry) => entry.root === group.root && group.paths.has(entry.path) && entry.seq < group.first)
    if (earlier) group.first = earlier.seq
  }
  return walkLines(turnChain(view, group), (ref) => linesOf(view, ref), (entry) => handOf(view, thread, scope, entry), UNKNOWN)
}

/** The two sides a diff shows: lines with their endings, null for no file. */
export interface ShownPair {
  before: readonly string[] | null
  after: readonly string[] | null
}

/**
 * Who wrote each changed line of a turn's diff of `file`, as runs on the
 * diff's sides. Without `shown`, the diff is the journal's: before the turn's
 * first entry on the file to after its last. With it (the turn's
 * checkpoints, saved as it started), the journal is walked from the turn's
 * start and each shown line takes the writer of the journal's line it
 * matches; a changed line the journal's span doesn't explain (written before
 * the turn began, or after its last entry on the file) takes its
 * neighbour's in the hunk, or `unknown`. Undefined when a version isn't kept
 * or the file isn't text.
 */
export function turnWriters(view: JournalView, thread: string, turn: string, file: TurnChangedFile, shown?: ShownPair): WriterRun[] | undefined {
  const walk = walkTurnFile(view, thread, turn, file, shown !== undefined)
  return walk && runsOn(walk, shown)
}

/** For each line of `to`, the line of `from` it is, or -1: the journal's line diff between them. */
function align(from: readonly string[], to: readonly string[]): Int32Array {
  const out = new Int32Array(to.length).fill(-1)
  let a = 0
  let b = 0
  const same = (until: number) => {
    for (; b < until; a++, b++) out[b] = a
  }
  for (const hunk of diffLines(from, to)) {
    same(hunk.b)
    a += hunk.removed
    b += hunk.added
  }
  same(to.length)
  return out
}

function runsOn(walk: Walk<Hand>, shown?: ShownPair): WriterRun[] {
  const before = original(walk)
  const after = present(walk)
  const texts = (lines: readonly WalkedLine<Hand>[]) => lines.map((line) => line.text)
  const shownBefore = shown ? shown.before ?? [] : texts(before)
  const shownAfter = shown ? shown.after ?? [] : texts(after)
  const fromBefore = shown ? align(texts(before), shownBefore) : undefined
  const fromAfter = shown ? align(texts(after), shownAfter) : undefined
  const marks: { side: WriterRun["side"]; line: number; hand: Hand }[] = []
  for (const hunk of diffLines(shownBefore, shownAfter)) {
    const lines: { side: WriterRun["side"]; line: number; hand: Hand | undefined }[] = []
    for (let i = 0; i < hunk.removed; i++) {
      const index = fromBefore ? fromBefore[hunk.a + i]! : hunk.a + i
      const gone = index >= 0 ? before[index]?.gone : undefined
      lines.push({ side: "deletions", line: hunk.a + i + 1, hand: gone?.by })
    }
    for (let i = 0; i < hunk.added; i++) {
      const index = fromAfter ? fromAfter[hunk.b + i]! : hunk.b + i
      lines.push({ side: "additions", line: hunk.b + i + 1, hand: (index >= 0 ? after[index]?.by : undefined) ?? undefined })
    }
    // A line the walk saw unchanged, or outside its span, takes its neighbour's writer in the hunk.
    let known: Hand | undefined
    for (const line of lines) line.hand = known = line.hand ?? known
    known = undefined
    for (const line of [...lines].reverse()) line.hand = known = line.hand ?? known
    for (const line of lines) marks.push({ side: line.side, line: line.line, hand: line.hand ?? UNKNOWN })
  }
  const runs: WriterRun[] = []
  const last = new Map<WriterRun["side"], WriterRun>()
  for (const mark of marks) {
    const run = last.get(mark.side)
    if (run && run.start + run.length === mark.line && run.writer === mark.hand.writer && run.thread === mark.hand.thread) run.length++
    else {
      const next: WriterRun = { side: mark.side, start: mark.line, length: 1, writer: mark.hand.writer, ...(mark.hand.thread && { thread: mark.hand.thread }) }
      runs.push(next)
      last.set(mark.side, next)
    }
  }
  return runs
}

/**
 * The turn's diff of `file` with only its own lines changed: every other
 * writer's change is on both sides, so it reads as context (a line they
 * added) or isn't there (a line they removed). "Maybe" lines aren't the
 * turn's for sure, so they count as others'.
 */
export function turnOnlyPair(view: JournalView, thread: string, turn: string, file: TurnChangedFile): { before: string | null; after: string | null } | undefined {
  const walk = walkTurnFile(view, thread, turn, file)
  if (!walk) return undefined
  const own = (hand: Hand | null) => hand?.writer === "turn"
  const before = walk.lines.filter((line) => (line.gone ? own(line.gone.by) && !own(line.by) : !own(line.by))).map((line) => line.text).join("")
  const after = present(walk).map((line) => line.text).join("")
  return { before: !walk.before && !before ? null : before, after: walk.after ? after : null }
}

/** What an undo writes to one file: from what it holds now (checked before the write) to what it gets. */
export interface UndoWrite {
  root: string
  /** Relative to its root. */
  path: string
  /** The journal's root path, which `path` is in. */
  rootPath: string
  current: ContentRef | null
  next: { kind: "absent" } | { kind: "text"; text: string } | { kind: "content"; ref: ContentRef }
}

export interface UndoPlan {
  writes: UndoWrite[]
  undo: TurnUndoFile[]
  kept: TurnUndoKept[]
  left: TurnUndoLeft[]
  token: string
}

/**
 * Every entry of a file from the scope's first on it to now, following it
 * through renames: a path another file takes after this one moved away
 * isn't this file's.
 */
function chainSince(view: JournalView, group: TurnFile): StoredEntry[] {
  const found = new Map<number, StoredEntry>()
  const paths = new Set(group.paths)
  const read = new Set<string>()
  for (let more = true; more; ) {
    more = false
    for (const path of paths) {
      if (read.has(path)) continue
      read.add(path)
      for (const entry of view.store.chain(group.root, path, group.first - 1)) found.set(entry.seq, entry)
    }
    for (const entry of found.values())
      if (entry.kind === "rename" && !paths.has(entry.path)) {
        paths.add(entry.path)
        more = true
      }
  }
  const out: StoredEntry[] = []
  let at = group.was
  for (const entry of [...found.values()].sort((a, b) => a.seq - b.seq)) {
    if ((entry.kind === "rename" ? entry.from : entry.path) !== at) continue
    out.push(entry)
    at = entry.path
  }
  return out
}

const keptNone = (): KeptLines => ({ person: 0, other: 0, thread: 0, maybe: 0, unknown: 0 })
const keptAny = (kept: KeptLines) => kept.person + kept.other + kept.thread + kept.maybe + kept.unknown > 0
const keptAdd = (kept: KeptLines, hand: Hand) => {
  if (hand.writer !== "turn") kept[hand.writer]++
}

/**
 * How to take a scope's own lines back out of the files as they are now:
 * a turn's (`kind: "turn"`), or every line the Thread wrote (`thread`), in
 * the checkout's repositories. Each file is walked from before the scope's
 * first entry on it to its last entry now. Lines the scope added and nobody
 * changed since go; lines it removed come back where they stood; every
 * other writer's lines stay. A stretch where someone else edited the
 * scope's lines since, or put back a line the scope removed, is left as it
 * is and named. A file the scope made, removed or renamed is removed, put
 * back or moved back, when only the scope touched it since.
 */
export function undoPlan(view: JournalView, thread: string, scope: TurnUndoScope, checkout: string): UndoPlan {
  const inside = new Map(rootsIn(view, checkout).map((root) => [root.root.id, root]))
  // Never what Git wrote: `entriesOfTurn` leaves it out already, and a Thread's entries may hold it.
  const entries = (scope.kind === "turn" ? view.store.entriesOfTurn(thread, scope.requestId) : view.store.entriesBy("thread", thread)).filter((entry) => inside.has(entry.root) && !entry.git)
  const sides = new Map(entries.map((entry) => [entry.seq, side(view.author(entry.seq), thread)]))
  const own = new Set(entries.filter((entry) => sides.get(entry.seq) === "thread").map((entry) => entry.seq))
  const plan: UndoPlan = { writes: [], undo: [], kept: [], left: [], token: "" }
  const named = (root: string, path: string) => relative(checkout, `${inside.get(root)!.root.path}/${path}`) || path
  const ownGroups = fileGroups(entries.filter((entry) => own.has(entry.seq)))
  for (const group of ownGroups.values()) planFile(view, thread, own, group, inside.get(group.root)!.root.path, inside.get(group.root)!.files, named, plan)
  // Files with only lines that might be the scope's: they stay, and say so.
  if (scope.kind === "turn") {
    const maybe = fileGroups(entries.filter((entry) => sides.get(entry.seq) === "uncertain"))
    for (const group of maybe.values()) {
      if ([...ownGroups.values()].some((mine) => mine.root === group.root && [...group.paths].some((path) => mine.paths.has(path)))) continue
      const kept = keptNone()
      const walk = walkLines(chainSince(view, group), (ref) => linesOf(view, ref), (entry) => handOf(view, thread, own, entry), UNKNOWN)
      for (const line of walk ? present(walk) : []) if (line.by) keptAdd(kept, line.by)
      plan.kept.push({ path: named(group.root, group.path), kept, why: "maybe" })
    }
  }
  plan.token = createHash("sha256")
    .update(JSON.stringify(plan.writes.map((write) => [write.root, write.path, write.current, write.next.kind === "text" ? createHash("sha256").update(write.next.text).digest("hex") : write.next.kind === "content" ? write.next.ref : null])))
    .digest("hex")
    .slice(0, 32)
  return plan
}

function planFile(view: JournalView, thread: string, own: ReadonlySet<number>, group: TurnFile, rootPath: string, files: ReadonlyMap<string, { current: ContentRef | null }>, named: (root: string, path: string) => string, plan: UndoPlan): void {
  const chain = chainSince(view, group)
  const first = chain[0]
  const last = chain.at(-1)
  if (!first || !last) return
  const hand = (entry: StoredEntry) => handOf(view, thread, own, entry)
  const mine = (value: Hand | null | undefined) => value?.writer === "turn"
  const finalPath = last.path
  const path = named(group.root, finalPath)
  const renames = chain.filter((entry) => entry.kind === "rename")
  // A file goes back to where it was only when every move of it since was the scope's.
  const back = renames.length > 0 && renames.every((entry) => own.has(entry.seq))
  const target = back ? group.was : finalPath
  const write = (from: string, current: ContentRef | null, next: UndoWrite["next"]) => plan.writes.push({ root: group.root, rootPath, path: from, current, next })
  // Something sits where the file would go back to: whoever put it there, it stays.
  if (target !== finalPath && (files.get(target)?.current ?? null) !== null) {
    plan.left.push({ path: named(group.root, target), reason: "edited-since", by: [] })
    return
  }
  const walk = walkLines(chain, (ref) => linesOf(view, ref), hand, UNKNOWN)
  if (!walk) {
    // Not text, or not kept: the whole file goes back, when only the scope changed it since.
    if (!chain.every((entry) => own.has(entry.seq))) {
      plan.left.push({ path, reason: "whole-file-changed-since", by: [...new Set(chain.filter((entry) => !own.has(entry.seq)).map((entry) => hand(entry).writer))] })
      return
    }
    if (first.before !== null && !view.store.hasBlob(first.before)) {
      plan.left.push({ path, reason: "content-not-kept", by: [] })
      return
    }
    const next: UndoWrite["next"] = first.before === null ? { kind: "absent" } : { kind: "content", ref: first.before }
    if (target !== finalPath) {
      write(finalPath, last.after, { kind: "absent" })
      write(target, null, next)
    } else write(finalPath, last.after, next)
    plan.undo.push({ path, kind: target !== finalPath ? "rename" : first.before === null ? "remove" : last.after === null ? "restore" : "lines", ...(target !== finalPath && { from: named(group.root, target) }), removes: 0, restores: 0, kept: keptNone() })
    return
  }
  // Removed since by someone else: what's left of it is theirs to bring back.
  if (!walk.after && !own.has(last.seq)) {
    plan.left.push({ path, reason: "edited-since", by: [hand(last).writer] })
    return
  }
  const lines = walk.lines
  const keep = lines.map((line) => !line.gone)
  let removes = 0
  let restores = 0
  let ownLeft = false
  for (let start = 0; start < lines.length; ) {
    const unchanged = (line: WalkedLine<Hand>) => !line.gone && line.by === null
    if (unchanged(lines[start]!)) {
      start++
      continue
    }
    let end = start
    while (end < lines.length && !unchanged(lines[end]!)) end++
    const region = lines.slice(start, end).map((line, offset) => ({ line, index: start + offset }))
    const taken = region.filter(({ line }) => !line.gone && mine(line.by))
    const putBack = region.filter(({ line }) => line.gone && mine(line.gone.by) && !mine(line.by))
    if (taken.length || putBack.length) {
      const editedOver = region.filter(({ line }) => mine(line.by) && line.gone && !mine(line.gone.by))
      const theirs = new Set(region.filter(({ line }) => !line.gone && !mine(line.by)).map(({ line }) => line.text))
      const clash = putBack.some(({ line }) => theirs.has(line.text))
      if (editedOver.length || clash) {
        const at = lines.slice(0, start).filter((line) => !line.gone).length
        const by = new Set<TurnWriter>()
        for (const { line } of region) {
          if (!line.gone && line.by && !mine(line.by)) by.add(line.by.writer)
          if (line.gone && !mine(line.gone.by)) by.add(line.gone.by.writer)
        }
        plan.left.push({ path, lines: { start: at + 1, length: region.filter(({ line }) => !line.gone).length }, reason: editedOver.length ? "edited-since" : "line-restored-by-another-writer", by: [...by] })
        ownLeft = true
      } else {
        for (const { index } of taken) keep[index] = false
        for (const { index } of putBack) keep[index] = true
        removes += taken.length
        restores += putBack.length
      }
    }
    start = end
  }
  const kept = keptNone()
  lines.forEach((line, index) => {
    if (keep[index] && !line.gone && line.by && !mine(line.by)) keptAdd(kept, line.by)
  })
  const text = lines.filter((_, index) => keep[index]).map((line) => line.text).join("")
  // A file the scope made that holds nobody else's line goes; one it removed comes back.
  const absent = !walk.before && !text && !keptAny(kept)
  const now = walk.after ? present(walk).map((line) => line.text).join("") : null
  const next: UndoWrite["next"] = absent ? { kind: "absent" } : { kind: "text", text }
  const changes = target !== finalPath || (absent ? now !== null : now !== text)
  if (changes) {
    if (target !== finalPath) {
      write(finalPath, walk.at, { kind: "absent" })
      write(target, null, next)
    } else write(finalPath, walk.at, next)
    plan.undo.push({
      path,
      kind: target !== finalPath ? "rename" : absent ? "remove" : now === null ? "restore" : "lines",
      ...(target !== finalPath && { from: named(group.root, target) }),
      removes,
      restores,
      kept,
    })
  }
  // Nothing of the scope's is left to take out: someone rewrote its lines since.
  const rewritten = !changes && !ownLeft && lines.some((line) => mine(line.by) && line.gone && !mine(line.gone.by))
  if (keptAny(kept) || rewritten) plan.kept.push({ path, kept, ...(rewritten && { why: "rewritten" as const }) })
}

/** A turn's or background work still running in `checkout`, on any host of this journal; undefined when none is. */
export function runningIn(view: JournalView, checkout: string): { thread: string; kind: "turn" | "background" } | undefined {
  const roots = rootsIn(view, checkout).map((root) => root.root.path)
  const inside = (folder: string | undefined) => folder !== undefined && roots.some((root) => folder === root || folder.startsWith(`${root}/`) || root.startsWith(`${folder}/`))
  for (const activity of view.store.openActivity()) {
    if (activity.kind === "call") continue
    if (inside(activity.checkout) || inside(activity.cwd)) return { thread: activity.thread, kind: activity.kind }
  }
  return undefined
}
