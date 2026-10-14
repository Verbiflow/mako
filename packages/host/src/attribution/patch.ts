import { splitLines } from "./line-diff.js"

/**
 * Apply a unified diff without its `---`/`+++` header to `before`, as a
 * tool reported it, to check that what changed on disk is exactly that
 * change. Each hunk is found by its old lines, first where its header says,
 * then anywhere after the previous hunk; undefined when one isn't there.
 */
export function applyPatch(before: string, patch: string): string | undefined {
  const lines = splitLines(before)
  const out: string[] = []
  let at = 0
  for (const hunk of parseHunks(patch)) {
    const start = find(lines, hunk.old, Math.max(at, hunk.start), at)
    if (start === undefined) return undefined
    for (let i = at; i < start; i++) out.push(lines[i]!)
    out.push(...hunk.added)
    at = start + hunk.old.length
  }
  for (let i = at; i < lines.length; i++) out.push(lines[i]!)
  return out.join("")
}

export interface ParsedHunk {
  /** Where the header puts it, from 0. */
  start: number
  old: string[]
  /** The hunk's new side: its context and the lines it added. */
  added: string[]
  /** Of `added`, which the hunk added; the rest is context. */
  fresh: boolean[]
}

const HEADER = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/

export function parseHunks(patch: string): ParsedHunk[] {
  const hunks: ParsedHunk[] = []
  let hunk: ParsedHunk | undefined
  /** The last line's mark, which a "\\ No newline" line refers to. */
  let lastWas = ""
  for (const raw of splitLines(patch)) {
    const header = HEADER.exec(raw)
    if (header) {
      hunk = { start: Math.max(0, Number(header[1]) - 1), old: [], added: [], fresh: [] }
      hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    const mark = raw[0]
    const line = raw.slice(1)
    if (mark === "\\") {
      // "\ No newline at end of file": the line before it has no ending, on the side it belongs to.
      if (lastWas !== "+") trimLast(hunk.old)
      if (lastWas !== "-") trimLast(hunk.added)
      continue
    }
    if (mark === " ") {
      hunk.old.push(line)
      hunk.added.push(line)
      hunk.fresh.push(false)
    } else if (mark === "-") hunk.old.push(line)
    else if (mark === "+") {
      hunk.added.push(line)
      hunk.fresh.push(true)
    }
    lastWas = mark ?? ""
  }
  return hunks
}

function trimLast(lines: string[]): void {
  const last = lines.at(-1)
  if (last !== undefined) lines[lines.length - 1] = last.replace(/\r?\n$/, "")
}

function find(lines: readonly string[], old: readonly string[], hint: number, from: number): number | undefined {
  const matches = (start: number) => old.every((line, i) => lines[start + i] === line)
  if (hint + old.length <= lines.length && matches(hint)) return hint
  for (let start = from; start + old.length <= lines.length; start++) if (matches(start)) return start
  return undefined
}
