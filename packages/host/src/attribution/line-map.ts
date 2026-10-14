import { diffLines, type Hunk } from "./line-diff.js"

/**
 * Who last wrote each line of a tracked file, as runs, updated per change in
 * time proportional to the diff.
 *
 * A run is consecutive lines from one source: the base (the content at the
 * commit tracking started from, `ins` 0, `origin` its line number) or one
 * journal entry (`ins` its sequence number, `origin` the line's number in the
 * content that entry wrote). Base lines stay in the map after they are
 * deleted, marked with the entry that deleted them (`del`), so a hunk against
 * the base knows who last removed its lines and where the new ones sit
 * among them. Lines an entry wrote and a later one replaced are simply gone: the
 * last writer is all that's kept. `over` records that a run replaced lines
 * another uncommitted entry wrote, which is what makes a hunk unsafe to
 * split line by line.
 */
export interface Run {
  ins: number
  origin: number
  length: number
  /** 0 while the line is there; else the entry that deleted it (base lines only), or `UNKNOWN`. */
  del: number
  /** The uncommitted entry whose lines these replaced, or 0. */
  over: number
}

export const BASE = 0
/** A line whose writer the tracker never saw: deleted in a commit it didn't watch, or kept out of one. */
export const UNKNOWN = -1

export function baseMap(lines: number): Run[] {
  return lines ? [{ ins: BASE, origin: 0, length: lines, del: 0, over: 0 }] : []
}

function joins(last: Run, run: Run): boolean {
  return last.ins === run.ins && last.del === run.del && last.over === run.over && last.origin + last.length === run.origin
}

function append(out: Run[], run: Run): void {
  if (run.length <= 0) return
  const last = out.at(-1)
  if (last && joins(last, run)) last.length += run.length
  else out.push({ ...run })
}

/** `map` after `entry` changed its present lines by `hunks` (from a diff of the present lines to the new content). */
export function applyHunks(map: readonly Run[], hunks: readonly Hunk[], entry: number): Run[] {
  const out: Run[] = []
  let index = 0
  /** Lines of `map[index]` already taken. */
  let taken = 0
  let alive = 0
  const current = (): Run | undefined => map[index]
  const advance = (count: number) => {
    taken += count
    if (taken >= map[index]!.length) {
      index++
      taken = 0
    }
  }
  /** Copy `count` present lines, and the deleted base lines among them, unchanged. */
  const copy = (count: number) => {
    while (count > 0) {
      const run = current()
      if (!run) throw new Error("The line map is shorter than the content it describes.")
      const left = run.length - taken
      if (run.del) {
        append(out, { ...run, origin: run.origin + taken, length: left })
        advance(left)
        continue
      }
      const take = Math.min(left, count)
      append(out, { ...run, origin: run.origin + taken, length: take })
      advance(take)
      count -= take
      alive += take
    }
  }
  /**
   * Delete `count` present lines: base lines stay, marked; written lines go.
   * Base lines already deleted among them, or just before them, are this
   * entry's now too: the lines it removed had replaced them, so it's the
   * last to write there. Returns the newest entry replaced.
   */
  const remove = (count: number): number => {
    let replaced = 0
    while (count > 0) {
      const run = current()
      if (!run) throw new Error("The line map is shorter than the content it describes.")
      const left = run.length - taken
      if (run.del) {
        append(out, { ...run, origin: run.origin + taken, length: left, del: entry })
        advance(left)
        continue
      }
      const take = Math.min(left, count)
      if (run.ins === BASE) append(out, { ...run, origin: run.origin + taken, length: take, del: entry })
      else replaced = Math.max(replaced, run.ins === UNKNOWN ? 0 : run.ins)
      advance(take)
      count -= take
      alive += take
    }
    return replaced
  }
  for (const hunk of hunks) {
    copy(hunk.a - alive)
    const replaced = remove(hunk.removed)
    append(out, { ins: entry, origin: hunk.b, length: hunk.added, del: 0, over: replaced })
  }
  while (index < map.length) {
    const run = map[index]!
    append(out, { ...run, origin: run.origin + taken, length: run.length - taken })
    index++
    taken = 0
  }
  return out
}

/** A run of present lines, numbered in the current content. */
export interface PresentRun {
  start: number
  length: number
  ins: number
  origin: number
  over: number
}

export function presentRuns(map: readonly Run[]): PresentRun[] {
  const out: PresentRun[] = []
  let line = 0
  for (const run of map) {
    if (run.del) continue
    out.push({ start: line, length: run.length, ins: run.ins, origin: run.origin, over: run.over })
    line += run.length
  }
  return out
}

export function presentLines(map: readonly Run[]): number {
  let count = 0
  for (const run of map) if (!run.del) count += run.length
  return count
}

/** Whether the map says the content is its base's: nothing written, nothing deleted. */
export function onlyBase(map: readonly Run[]): boolean {
  return map.every((run) => run.ins === BASE && !run.del)
}

/** The writer of each line `0..lines` of the current content. */
export function writers(map: readonly Run[]): Int32Array {
  const out = new Int32Array(presentLines(map))
  let line = 0
  for (const run of map) {
    if (run.del) continue
    out.fill(run.ins, line, line + run.length)
    line += run.length
  }
  return out
}

/**
 * The map after a commit made `committed` the base, and who last wrote each
 * committed line (`BASE` for lines from before tracking, `UNKNOWN` for lines
 * the commit has that the tracker never saw on disk). Present lines the
 * commit took become base lines; present lines it didn't take stay
 * uncommitted with their writers. A committed line that isn't present was
 * deleted after the commit's content was staged: it stays deleted, by whoever
 * deleted that base line, when the map still holds it.
 *
 * `known` is who last wrote each line of `base`, from the commit that made
 * it: a base line the new commit drops while the disk keeps it is that
 * writer's again, not unknown.
 */
export interface Rebased {
  map: Run[]
  /** Each committed line's writer: an entry, `BASE`, or `UNKNOWN`. */
  authors: Int32Array
}

export function rebase(map: readonly Run[], present: readonly string[], base: readonly string[], committed: readonly string[], known?: Int32Array): Rebased {
  const writerOf = (line: number, otherwise: number) => {
    const writer = known?.[line] ?? 0
    return writer > 0 ? writer : otherwise
  }
  /** Each present line's run fields, and the deleted base lines just before it. */
  const ins = new Int32Array(present.length)
  const origin = new Int32Array(present.length)
  const over = new Int32Array(present.length)
  const deletedBefore: { text: string; del: number }[][] = Array.from({ length: present.length + 1 }, () => [])
  let at = 0
  for (const run of map)
    for (let i = 0; i < run.length; i++) {
      if (run.del) deletedBefore[at]!.push({ text: base[run.origin + i] ?? "", del: run.del })
      else {
        ins[at] = run.ins
        origin[at] = run.origin + i
        over[at] = run.over
        at++
      }
    }
  const hunks = diffLines(present, committed)
  preferWrittenUncommitted(hunks, present, ins, origin, over)
  const authors = new Int32Array(committed.length).fill(UNKNOWN)
  const out: Run[] = []
  let i = 0
  let j = 0
  const same = (count: number) => {
    for (let k = 0; k < count; k++, i++, j++) {
      authors[j] = ins[i] === BASE ? writerOf(origin[i]!, BASE) : ins[i]!
      append(out, { ins: BASE, origin: j, length: 1, del: 0, over: 0 })
    }
  }
  for (const hunk of hunks) {
    same(hunk.a - i)
    // Deleted base lines around the hunk, to name who deleted a committed line that isn't present.
    const deleted = deletedBefore.slice(hunk.a, hunk.a + hunk.removed + 1).flat()
    for (let k = 0; k < hunk.added; k++, j++) {
      const found = deleted.findIndex((line) => line.text === committed[j])
      const del = found >= 0 ? deleted.splice(found, 1)[0]!.del : UNKNOWN
      authors[j] = BASE
      append(out, { ins: BASE, origin: j, length: 1, del, over: 0 })
    }
    for (let k = 0; k < hunk.removed; k++, i++) append(out, { ins: ins[i] === BASE ? writerOf(origin[i]!, UNKNOWN) : ins[i]!, origin: origin[i]!, length: 1, del: 0, over: over[i]! })
  }
  same(present.length - i)
  return { map: out, authors }
}

/**
 * Among identical lines, which the commit took is the diff's choice, not
 * the disk's. A base line stays uncommitted only when a commit dropped it
 * and the disk kept it; a line an entry wrote after the commit was staged
 * stays uncommitted all the time. So where the diff left a base line out of
 * the commit and took an identical line an entry wrote, the two trade
 * writers, the nearest first.
 */
function preferWrittenUncommitted(hunks: readonly Hunk[], present: readonly string[], ins: Int32Array, origin: Int32Array, over: Int32Array): void {
  const left: number[] = []
  const taken = new Map<string, number[]>()
  let i = 0
  const keep = (count: number) => {
    for (let k = 0; k < count; k++, i++) {
      if (ins[i]! <= 0) continue
      const same = taken.get(present[i]!)
      if (same) same.push(i)
      else taken.set(present[i]!, [i])
    }
  }
  for (const hunk of hunks) {
    keep(hunk.a - i)
    for (let k = 0; k < hunk.removed; k++, i++) if (ins[i] === BASE) left.push(i)
  }
  keep(present.length - i)
  for (const line of left) {
    const same = taken.get(present[line]!)
    if (!same?.length) continue
    let nearest = 0
    for (let k = 1; k < same.length; k++) if (Math.abs(same[k]! - line) < Math.abs(same[nearest]! - line)) nearest = k
    const other = same.splice(nearest, 1)[0]!
    for (const fields of [ins, origin, over]) [fields[line], fields[other]] = [fields[other]!, fields[line]!]
  }
}

/**
 * `map` with its present `UNKNOWN` lines given to their writers in `known`,
 * indexed by `origin`: lines a clean file kept on disk when HEAD moved past
 * them, whose content an earlier commit recorded writers for.
 */
export function withKnownWriters(map: readonly Run[], known: Int32Array | undefined): Run[] {
  if (!known) return [...map]
  const out: Run[] = []
  for (const run of map) {
    if (run.ins !== UNKNOWN || run.del) {
      append(out, run)
      continue
    }
    for (let k = 0; k < run.length; k++) {
      const writer = known[run.origin + k] ?? 0
      append(out, { ...run, ins: writer > 0 ? writer : UNKNOWN, origin: run.origin + k, length: 1 })
    }
  }
  return out
}

/** `map` with the present lines `lines` (numbered in the current content) written by `entry`, which wrote that content. */
export function withWriter(map: readonly Run[], lines: ReadonlySet<number>, entry: number): Run[] {
  const out: Run[] = []
  let line = 0
  for (const run of map) {
    if (run.del) {
      append(out, run)
      continue
    }
    for (let k = 0; k < run.length; k++, line++)
      append(out, lines.has(line) ? { ins: entry, origin: line, length: 1, del: 0, over: run.over } : { ...run, origin: run.origin + k, length: 1 })
  }
  return out
}

/** Five 32-bit fields a run, for the journal. */
export function encodeMap(map: readonly Run[]): Uint8Array {
  const out = new Int32Array(map.length * 5)
  map.forEach((run, at) => out.set([run.ins, run.origin, run.length, run.del, run.over], at * 5))
  return new Uint8Array(out.buffer)
}

export function decodeMap(bytes: Uint8Array): Run[] {
  if (bytes.byteLength % 20) throw new Error("A stored line map is damaged.")
  const fields = new Int32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const out: Run[] = []
  for (let at = 0; at < fields.length; at += 5)
    out.push({ ins: fields[at]!, origin: fields[at + 1]!, length: fields[at + 2]!, del: fields[at + 3]!, over: fields[at + 4]! })
  return out
}
