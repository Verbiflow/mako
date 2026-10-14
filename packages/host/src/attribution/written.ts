import type { ReportedEffect } from "@mako/protocol"
import { diffLines, splitLines } from "./line-diff.js"
import { parseHunks } from "./patch.js"

/*
 * The lines a call's reported effect wrote, found in a file as it is now:
 * what lets a call read back from a record claim lines a change left
 * uncertain, after the change and without its timing. An edit or a hunk is
 * a block, its new side with the lines it added marked; a whole file's
 * content is matched by a diff instead. Only text two writers wouldn't type
 * alike counts: a lone `}` proves nothing.
 */

/** A line this long, trimmed, is no coincidence on its own. */
const DISTINCT_LINE = 20
/** Lines with this much text, trimmed, make a run no coincidence together. */
const DISTINCT_LINES = 2
const WORDY = /[A-Za-z0-9]/

interface Block {
  lines: string[]
  added: boolean[]
  /** The first line starts mid-line, or the last ends mid-line: matched as a line's end or start. */
  partialStart: boolean
  partialEnd: boolean
}

/** Whether these lines are text a second writer wouldn't have typed the same. */
export function distinct(lines: readonly string[]): boolean {
  let wordy = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!WORDY.test(trimmed)) continue
    if (trimmed.length >= DISTINCT_LINE) return true
    if (trimmed.length >= 4) wordy++
  }
  return wordy >= DISTINCT_LINES
}

/** Which of `current`'s lines `effect` wrote, by its reported content; empty when it reports none. */
export function writtenLines(effect: ReportedEffect, current: readonly string[]): Set<number> {
  const found = new Set<number>()
  if ("seen" in effect && effect.seen) return found
  if ((effect.kind === "create" || effect.kind === "write") && effect.content !== undefined) {
    wholeContent(splitLines(effect.content), current, found)
    return found
  }
  if (effect.kind !== "modify") return found
  const blocks = effect.patch !== undefined
    ? parseHunks(effect.patch).map((hunk): Block => ({ lines: hunk.added, added: hunk.fresh, partialStart: false, partialEnd: false }))
    : (effect.edits ?? []).map(editBlock)
  for (const block of blocks) matchBlock(block, current, found)
  return found
}

/** The lines of `current` in stretches the diff keeps from `written`. */
function wholeContent(written: readonly string[], current: readonly string[], found: Set<number>): void {
  let a = 0
  let b = 0
  const keep = (count: number) => {
    if (count > 0 && distinct(current.slice(b, b + count))) for (let k = 0; k < count; k++) found.add(b + k)
    a += count
    b += count
  }
  for (const hunk of diffLines(written, current)) {
    keep(hunk.a - a)
    a = hunk.a + hunk.removed
    b = hunk.b + hunk.added
  }
  keep(written.length - a)
}

/**
 * An edit's new text as a block: the lines a diff against its old text says
 * it added. Nothing says where in a line its text starts, so its first line
 * is matched as a line's end (a whole line ends with itself too).
 */
function editBlock(edit: { old: string; new: string }): Block {
  const lines = splitLines(edit.new)
  const added = lines.map(() => false)
  for (const hunk of diffLines(splitLines(edit.old), lines)) for (let k = 0; k < hunk.added; k++) added[hunk.b + k] = true
  return { lines, added, partialStart: true, partialEnd: lines.length > 0 && !lines.at(-1)!.endsWith("\n") }
}

/** Where `block` sits in `current`, whole; else where each of its distinct added runs does. */
function matchBlock(block: Block, current: readonly string[], found: Set<number>): void {
  if (!block.lines.length) return
  const whole = occurrences(block, current)
  if (whole.length && distinct(block.lines.filter((_, k) => block.added[k]))) {
    for (const at of whole) block.added.forEach((added, k) => added && found.add(at + k))
    return
  }
  // Lines written after it changed the block around them: its added runs, each where it still is whole.
  let k = 0
  while (k < block.lines.length) {
    if (!block.added[k]) {
      k++
      continue
    }
    let end = k
    while (end < block.lines.length && block.added[end]) end++
    const run: Block = {
      lines: block.lines.slice(k, end),
      added: block.lines.slice(k, end).map(() => true),
      partialStart: k === 0 && block.partialStart,
      partialEnd: end === block.lines.length && block.partialEnd,
    }
    if (distinct(run.lines)) for (const at of occurrences(run, current)) for (let i = 0; i < run.lines.length; i++) found.add(at + i)
    k = end
  }
}

/** Every line of `current` where `block` starts, its partial ends matched as a line's end and start. */
function occurrences(block: Block, current: readonly string[]): number[] {
  const n = block.lines.length
  const fits = (at: number, k: number) => {
    const line = current[at + k]
    if (line === undefined) return false
    const want = block.lines[k]!
    const first = k === 0 && block.partialStart
    const last = k === n - 1 && block.partialEnd
    if (first && last) return line.includes(want)
    if (first) return line.endsWith(want)
    if (last) return line.startsWith(want)
    return line === want
  }
  const anchor = block.lines.findIndex((_, k) => !(k === 0 && block.partialStart) && !(k === n - 1 && block.partialEnd))
  const out: number[] = []
  if (anchor < 0) {
    // One partial line: only a distinct one, anywhere.
    if (!distinct(block.lines)) return out
    for (let at = 0; at + n <= current.length; at++) if (block.lines.every((_, k) => fits(at, k))) out.push(at)
    return out
  }
  const want = block.lines[anchor]!
  for (let at = anchor; at < current.length; at++) {
    if (current[at] !== want) continue
    const start = at - anchor
    if (start + n <= current.length && block.lines.every((_, k) => fits(start, k))) out.push(start)
  }
  return out
}
