import { open } from "node:fs/promises"
import { join } from "node:path"
import { run } from "./run.js"

/** Lines a file adds and removes; null for a binary file, or one too large or unreadable to count. */
export type LineCount = { insertions: number; deletions: number } | null

/** An untracked file past this size isn't read to count its lines. */
const COUNT_BYTES = 1024 * 1024
/** Git's own test for binary content: a NUL in the first 8000 bytes. */
const BINARY_PROBE = 8000
const READS_AT_ONCE = 16

/** One file of `--numstat` output; `from` is the old path of a rename. */
export interface NumstatEntry {
  path: string
  from?: string
  lines: LineCount
}

/** `--numstat -z` output in order. With renames on, a rename's record has an empty path, then its old and new paths. */
export function numstatEntries(output: Buffer): NumstatEntry[] {
  const entries: NumstatEntry[] = []
  const fields = output.toString("utf8").split("\0")
  for (let at = 0; at < fields.length; at += 1) {
    const record = fields[at]!
    const first = record.indexOf("\t")
    const second = record.indexOf("\t", first + 1)
    if (first < 0 || second < 0) continue
    const insertions = record.slice(0, first)
    const deletions = record.slice(first + 1, second)
    const lines = insertions === "-" ? null : { insertions: Number(insertions), deletions: Number(deletions) }
    const named = record.slice(second + 1)
    if (named) entries.push({ path: named, lines })
    else {
      const from = fields[at + 1] ?? ""
      const path = fields[at + 2] ?? ""
      at += 2
      entries.push({ path, from, lines })
    }
  }
  return entries
}

/** `--numstat -z --no-renames` output, by path. */
export function parseNumstat(output: Buffer): Map<string, LineCount> {
  return new Map(numstatEntries(output).map((entry) => [entry.path, entry.lines]))
}

/** Lines each tracked file in the working tree adds and removes against `base`; every changed one when `paths` is omitted. */
export async function worktreeLines(root: string, base: string, paths?: readonly string[]): Promise<Map<string, LineCount>> {
  const scope = paths ? paths.map((path) => `:(literal)${path}`) : []
  const result = await run({ cwd: root, args: ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", base, "--", ...scope], read: true })
  return parseNumstat(result.stdout)
}

/** What `oid` changed against its first parent, by line. */
export async function commitLines(root: string, oid: string): Promise<Map<string, LineCount>> {
  const result = await run({ cwd: root, args: ["diff-tree", "--root", "--no-commit-id", "--numstat", "--no-renames", "-r", "-m", "--first-parent", "-z", oid, "--"], read: true })
  return parseNumstat(result.stdout)
}

/** Each untracked file's lines, all of them added. */
export async function untrackedLines(root: string, paths: readonly string[]): Promise<Map<string, LineCount>> {
  const counts = new Map<string, LineCount>()
  for (let offset = 0; offset < paths.length; offset += READS_AT_ONCE) {
    const batch = paths.slice(offset, offset + READS_AT_ONCE)
    const read = await Promise.all(batch.map((path) => fileLines(join(root, path))))
    batch.forEach((path, index) => counts.set(path, read[index]!))
  }
  return counts
}

async function fileLines(path: string): Promise<LineCount> {
  const handle = await open(path, "r").catch(() => null)
  if (!handle) return null
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > COUNT_BYTES) return null
    const bytes = info.size === 0 ? Buffer.alloc(0) : await handle.readFile()
    if (bytes.subarray(0, BINARY_PROBE).includes(0)) return null
    let lines = 0
    for (let at = bytes.indexOf(10); at >= 0; at = bytes.indexOf(10, at + 1)) lines += 1
    if (bytes.length > 0 && bytes[bytes.length - 1] !== 10) lines += 1
    return { insertions: lines, deletions: 0 }
  } finally {
    await handle.close()
  }
}
