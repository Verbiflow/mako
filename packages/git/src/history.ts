import type { Change } from "./status.js"
import { run } from "./run.js"

export interface CommitEntry {
  oid: string
  shortOid: string
  author: string
  /** ISO 8601, as the author recorded it. */
  date: string
  subject: string
}

export interface CommitFile {
  path: string
  change: Change
}

/** The newest `limit` commits reachable from HEAD; none before the first commit. */
export async function log(root: string, limit: number): Promise<CommitEntry[]> {
  const result = await run({ cwd: root, args: ["log", `-${Math.max(1, Math.min(500, Math.floor(limit)))}`, "-z", "--date-order", "--format=%H%x00%h%x00%an%x00%aI%x00%s", "HEAD", "--"], codes: [128], read: true })
  if (result.code !== 0) return []
  const fields = result.stdout.toString("utf8").split("\0")
  const entries: CommitEntry[] = []
  for (let at = 0; at + 4 < fields.length; at += 5) {
    entries.push({ oid: fields[at]!.replace(/^\n/, ""), shortOid: fields[at + 1]!, author: fields[at + 2]!, date: fields[at + 3]!, subject: fields[at + 4]! })
  }
  return entries
}

const CHANGES = new Map<string, Change>([["A", "added"], ["D", "deleted"], ["T", "typechange"]])

/** What `oid` changed against its first parent. */
export async function commitFiles(root: string, oid: string): Promise<CommitFile[]> {
  const result = await run({ cwd: root, args: ["diff-tree", "--root", "--no-commit-id", "--name-status", "--no-renames", "-r", "-m", "--first-parent", "-z", oid, "--"], read: true })
  const fields = result.stdout.toString("utf8").split("\0")
  const files: CommitFile[] = []
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const code = fields[at]!.trim()
    if (!code) continue
    files.push({ path: fields[at + 1]!, change: CHANGES.get(code[0]!) ?? "modified" })
  }
  return files
}

/** Tracked files, and untracked ones Git doesn't ignore. */
export async function listFiles(root: string): Promise<string[]> {
  const result = await run({ cwd: root, args: ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], read: true })
  // A conflicted file is listed once for each of its stages.
  return [...new Set(result.stdout.toString("utf8").split("\0").filter(Boolean))]
}

export interface GrepOptions {
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
}

/** `path:line:text` for each match in tracked and untracked text files. */
export async function grep(root: string, term: string, options: GrepOptions = {}): Promise<string[]> {
  if (Buffer.byteLength(term) > 4096) throw new Error("Search query exceeds the input budget")
  const args = ["grep", "--no-color", "-n", "-I", "--untracked"]
  if (!options.caseSensitive) args.push("-i")
  if (options.wholeWord) args.push("-w")
  args.push(options.regex ? "-E" : "-F", "-e", term, "--")
  const result = await run({ cwd: root, args, codes: [1], maxBytes: 16 * 1024 * 1024, timeoutMs: 15_000, read: true })
  if (result.code === 1) return []
  const lines = result.stdout.toString("utf8").split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}
