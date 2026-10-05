/** A change on one side of a status entry. Renames are read as a delete and an add. */
export type Change = "added" | "modified" | "deleted" | "typechange"

export interface StatusEntry {
  /** Relative to the repository root, with `/` separators. */
  path: string
  /** Against HEAD in the index; null when the index matches HEAD. */
  index: Change | null
  /** Against the index in the working tree; null when they match. */
  worktree: Change | null
  untracked: boolean
  conflicted: boolean
  submodule: boolean
  /** The path's bytes when they aren't valid UTF-8, for commands that take bytes. */
  raw?: Buffer
}

export interface StatusHead {
  /** Null on a branch with no commits yet. */
  oid: string | null
  /** Null when HEAD is detached. */
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
}

export interface ParsedStatus {
  head: StatusHead
  entries: StatusEntry[]
}

function change(code: string): Change | null {
  switch (code) {
    case ".": return null
    case "A": case "C": case "R": return "added"
    case "D": return "deleted"
    case "T": return "typechange"
    default: return "modified"
  }
}

const strict = new TextDecoder("utf-8", { fatal: true })

/**
 * `git status --porcelain=v2 --branch -z` output. Paths are bytes; one that
 * isn't valid UTF-8 keeps them in `raw`, since its text can't name it to Git.
 */
export function parseStatus(output: Buffer): ParsedStatus {
  const head: StatusHead = { oid: null, branch: null, upstream: null, ahead: 0, behind: 0 }
  const entries: StatusEntry[] = []
  let valid = true
  try { strict.decode(output) } catch { valid = false }
  // Output that is all UTF-8, nearly always, is split as text; otherwise each record keeps its bytes.
  const bytes = valid ? null : splitBytes(output)
  const lines = bytes ? bytes.map((record) => record.toString("latin1")) : output.toString("utf8").split("\0")
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line === "") continue
    const tag = line[0]
    if (tag === "#") {
      readHeader(bytes ? bytes[index]!.toString("utf8") : line, head)
      continue
    }
    const fields = tag === "1" ? 8 : tag === "2" ? 9 : tag === "u" ? 10 : tag === "?" ? 1 : -1
    if (fields < 0) continue
    const offset = nthSpace(line, fields) + 1
    const path = bytes ? pathOfBytes(bytes[index]!, offset) : { path: line.slice(offset) }
    if (tag === "2") index += 1
    if (tag === "?") {
      entries.push({ ...path, index: null, worktree: "added", untracked: true, conflicted: false, submodule: false })
      continue
    }
    const xy = line.slice(2, 4)
    const submodule = line[5] === "S"
    if (tag === "u") {
      entries.push({ ...path, index: "modified", worktree: "modified", untracked: false, conflicted: true, submodule })
      continue
    }
    entries.push({ ...path, index: change(xy[0]!), worktree: change(xy[1]!), untracked: false, conflicted: false, submodule })
  }
  return { head, entries }
}

function readHeader(line: string, head: StatusHead): void {
  const space = line.indexOf(" ", 2)
  const key = line.slice(2, space)
  const value = line.slice(space + 1)
  switch (key) {
    case "branch.oid": head.oid = value === "(initial)" ? null : value; break
    case "branch.head": head.branch = value === "(detached)" ? null : value; break
    case "branch.upstream": head.upstream = value; break
    case "branch.ab": {
      const match = /^\+(\d+) -(\d+)$/.exec(value)
      if (match) { head.ahead = Number(match[1]); head.behind = Number(match[2]) }
      break
    }
  }
}

function nthSpace(line: string, count: number): number {
  let at = -1
  for (let seen = 0; seen < count; seen += 1) {
    at = line.indexOf(" ", at + 1)
    if (at < 0) return line.length
  }
  return at
}

interface EntryPath {
  path: string
  raw?: Buffer
}

function pathOfBytes(record: Buffer, offset: number): EntryPath {
  const bytes = record.subarray(offset)
  const path = bytes.toString("utf8")
  try {
    strict.decode(bytes)
  } catch {
    const named: EntryPath = { path, raw: Buffer.from(bytes) }
    return named
  }
  const named: EntryPath = { path }
  return named
}

function splitBytes(output: Buffer): Buffer[] {
  const records: Buffer[] = []
  let start = 0
  for (let at = output.indexOf(0); at >= 0; at = output.indexOf(0, start)) {
    records.push(output.subarray(start, at))
    start = at + 1
  }
  if (start < output.length) records.push(output.subarray(start))
  return records
}

/** Byte order, which is Git's: a directory's entries sort together after `name-`. */
export function comparePaths(a: string, b: string): number {
  const length = Math.min(a.length, b.length)
  for (let at = 0; at < length; at += 1) {
    let x = a.charCodeAt(at)
    let y = b.charCodeAt(at)
    if (x === y) continue
    // UTF-16 puts surrogates below U+E000; UTF-8, like code points, puts them above U+FFFF.
    if (x >= 0xd800 && y >= 0xd800) {
      x = x < 0xe000 ? x + 0x2000 : x - 0x800
      y = y < 0xe000 ? y + 0x2000 : y - 0x800
    }
    return x - y
  }
  return a.length - b.length
}

/** Git's status order: changes by path, then untracked files by path. */
function compareEntries(a: StatusEntry, b: StatusEntry): number {
  return Number(a.untracked) - Number(b.untracked) || comparePaths(a.path, b.path)
}

/** Whether `path` is `scope` or inside it. */
export function within(path: string, scope: string): boolean {
  return path === scope || (path.length > scope.length && path.startsWith(scope) && path[scope.length] === "/")
}

/**
 * The entries with every path in `scopes` read again: what was there for them
 * goes, and `fresh` (a status limited to `scopes`) takes its place.
 */
export function mergeStatus(previous: readonly StatusEntry[], scopes: readonly string[], fresh: readonly StatusEntry[]): StatusEntry[] {
  const reread = new Set(scopes)
  const covered = (path: string) => {
    for (let end = path.length; end > 0; end = path.lastIndexOf("/", end - 1)) if (reread.has(end === path.length ? path : path.slice(0, end))) return true
    return false
  }
  const kept = previous.filter((entry) => !covered(entry.path))
  if (fresh.length === 0) return kept
  const merged: StatusEntry[] = []
  let at = 0
  for (const entry of fresh) {
    while (at < kept.length && compareEntries(kept[at]!, entry) < 0) merged.push(kept[at++]!)
    merged.push(entry)
  }
  while (at < kept.length) merged.push(kept[at++]!)
  return merged
}

/** A path whose status two reads disagree on; null where one has no entry for it. */
export interface StatusMismatch {
  path: string
  held: string | null
  fresh: string | null
}

/** Porcelain-style codes for one entry: `MM`, `A.`, `??`, `UU`, with `S` for a submodule. */
export function statusCode(entry: StatusEntry): string {
  if (entry.untracked) return "??"
  if (entry.conflicted) return "UU"
  const side = (change: Change | null) => change === null ? "." : change === "typechange" ? "T" : change[0]!.toUpperCase()
  return `${side(entry.index)}${side(entry.worktree)}${entry.submodule ? " S" : ""}`
}

/** Every path where `held` and `fresh` disagree, in `fresh`'s order and then `held`'s leftovers. */
export function statusMismatches(held: readonly StatusEntry[], fresh: readonly StatusEntry[]): StatusMismatch[] {
  const kept = new Map(held.map((entry) => [entry.path, statusCode(entry)]))
  const mismatches: StatusMismatch[] = []
  for (const entry of fresh) {
    const code = statusCode(entry)
    const was = kept.get(entry.path) ?? null
    kept.delete(entry.path)
    if (was !== code) mismatches.push({ path: entry.path, held: was, fresh: code })
  }
  for (const [path, code] of kept) mismatches.push({ path, held: code, fresh: null })
  return mismatches
}
