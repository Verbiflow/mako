import type { ContentRef } from "@mako/protocol"
import type { StoredEntry } from "./journal-store.js"
import { diffLines } from "./line-diff.js"

/*
 * One file's lines across a stretch of its entries, each with who wrote it
 * and, once it's gone, who took it out. Every entry's change is the
 * journal's own line diff of its two sides, so what this says agrees with
 * the line maps and with every count made from it: a turn's lines
 * (`turnChanges`), who wrote each changed line of its diff, and the lines an
 * undo takes out or puts back (`turn-lines.ts`).
 */

export interface WalkedLine<T> {
  text: string
  /** Who wrote it; null for a line there before the stretch. */
  by: T | null
  /** The entry that wrote it; 0 for a line there before. */
  seq: number
  /** Who took it out, once it's gone; a gone line stays where it was, between the lines around it. */
  gone?: { by: T; seq: number }
}

export interface Walk<T> {
  /** Every line there was, in order: those there now, and those taken out where they stood. */
  lines: WalkedLine<T>[]
  /** Whether the file was there before the stretch, and after it. */
  before: boolean
  after: boolean
  /** The content after the stretch. */
  at: ContentRef | null
}

/**
 * Walk `chain` (one file's entries, oldest first). `read` gives a version's
 * lines, undefined when its content isn't kept; `tagOf` names an entry's
 * writer, and `between` whoever changed the file between two entries the
 * journal kept apart. An entry Git wrote (`git`: a checkout, a pull, a
 * stash) is `tagOf`'s to name, except that a version Git put back which the
 * walk has seen (a stash popped) comes back with the writers it had.
 * Undefined when some version isn't kept or isn't text.
 */
export function walkLines<T>(chain: readonly StoredEntry[], read: (ref: ContentRef | null) => string[] | undefined, tagOf: (entry: StoredEntry) => T, between: T): Walk<T> | undefined {
  let lines: WalkedLine<T>[] = []
  let at: ContentRef | null | undefined
  const apply = (next: readonly string[], by: T, seq: number) => {
    const live = lines.filter((line) => !line.gone)
    const out: WalkedLine<T>[] = []
    let item = 0
    let index = 0
    /** Lines up to the live one at `target`, those gone before it included. */
    const copyTo = (target: number) => {
      while (item < lines.length) {
        const line = lines[item]!
        if (!line.gone) {
          if (index >= target) return
          index++
        }
        out.push(line)
        item++
      }
    }
    for (const hunk of diffLines(live.map((line) => line.text), next)) {
      copyTo(hunk.a)
      for (let removed = 0; removed < hunk.removed; ) {
        const line = lines[item++]!
        if (line.gone) {
          out.push(line)
          continue
        }
        out.push({ ...line, gone: { by, seq } })
        index++
        removed++
      }
      // What takes their place stands right where they stood: a line taken out
      // before, just after them, stood before the next line and stays there.
      for (let added = 0; added < hunk.added; added++) out.push({ text: next[hunk.b + added]!, by, seq })
    }
    while (item < lines.length) out.push(lines[item++]!)
    lines = out
  }
  let before = false
  /** Each version the walk has been at, with its lines then. */
  const versions = new Map<ContentRef | null, WalkedLine<T>[]>()
  for (const [index, entry] of chain.entries()) {
    if (!entry.text && (entry.before !== null || entry.after !== null)) return undefined
    if (index === 0) {
      const first = read(entry.before)
      if (!first) return undefined
      lines = first.map((text) => ({ text, by: null, seq: 0 }))
      before = entry.before !== null
      versions.set(entry.before, lines)
    } else if (entry.before !== at) {
      // Something between two entries the journal kept apart: whoever it was, it wasn't this entry's writer.
      const gap = read(entry.before)
      if (!gap) return undefined
      apply(gap, between, 0)
      versions.set(entry.before, lines)
    }
    const after = read(entry.after)
    if (!after) return undefined
    const put = entry.git && entry.before === at ? versions.get(entry.after) : undefined
    if (put) lines = put
    else apply(after, tagOf(entry), entry.seq)
    versions.set(entry.after, lines)
    at = entry.after
  }
  return { lines, before, after: (at ?? null) !== null, at: at ?? null }
}

/** The lines there after the walk, in order. */
export const present = <T>(walk: Walk<T>) => walk.lines.filter((line) => !line.gone)

/** The lines there before the walk, in order: those still there and those since taken out. */
export const original = <T>(walk: Walk<T>) => walk.lines.filter((line) => line.by === null)
