import type { Change } from "./status.js"
import { commitLines, untrackedLines, worktreeLines, type LineCount } from "./lines.js"
import { run } from "./run.js"

/** Past this many files, a commit's or a comparison's lines aren't counted. */
const COUNTED_FILES = 2_000

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
  /** Undefined when there were too many files to count. */
  lines?: LineCount
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
  const [result, lines] = await Promise.all([
    run({ cwd: root, args: ["diff-tree", "--root", "--no-commit-id", "--name-status", "--no-renames", "-r", "-m", "--first-parent", "-z", oid, "--"], read: true }),
    commitLines(root, oid),
  ])
  return nameStatus(result.stdout).map((file) => ({ ...file, lines: counted(lines, file.path) }))
}

/** A path's count; one Git lists no lines for changed only its mode. */
function counted(lines: ReadonlyMap<string, LineCount>, path: string): LineCount {
  return lines.has(path) ? lines.get(path)! : { insertions: 0, deletions: 0 }
}

function nameStatus(output: Buffer): CommitFile[] {
  const fields = output.toString("utf8").split("\0")
  const files: CommitFile[] = []
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const code = fields[at]!.trim()
    if (!code) continue
    files.push({ path: fields[at + 1]!, change: CHANGES.get(code[0]!) ?? "modified" })
  }
  return files
}

/**
 * Where HEAD left `ref`, and every file that differs from there in the
 * working tree: committed since, staged, unstaged and untracked. Null when
 * `ref` names nothing or shares no history with HEAD.
 */
export async function changedSince(root: string, ref: string): Promise<{ base: string; files: CommitFile[] } | null> {
  if (!ref || ref.startsWith("-") || ref.includes("\0")) return null
  const merged = await run({ cwd: root, args: ["merge-base", "HEAD", ref], codes: [1, 128], read: true })
  const base = merged.code === 0 ? merged.stdout.toString("utf8").trim() : ""
  if (!base) return null
  const [tracked, untracked] = await Promise.all([
    run({ cwd: root, args: ["diff", "--name-status", "--no-renames", "-z", base, "--"], read: true }),
    run({ cwd: root, args: ["ls-files", "-z", "--others", "--exclude-standard"], read: true }),
  ])
  const files = nameStatus(tracked.stdout)
  const added = untracked.stdout.toString("utf8").split("\0").filter(Boolean)
  if (files.length + added.length <= COUNTED_FILES) {
    const [diffed, read] = await Promise.all([worktreeLines(root, base), untrackedLines(root, added)])
    for (const file of files) file.lines = counted(diffed, file.path)
    for (const path of added) files.push({ path, change: "added", lines: counted(read, path) })
  } else for (const path of added) files.push({ path, change: "added" })
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { base, files }
}

/**
 * The branch work here lands on, read without a host: the one origin's HEAD
 * names, else `init.defaultBranch`, main or master, whichever exists here or
 * on origin. Null when none does.
 */
export async function defaultBranch(root: string): Promise<string | null> {
  const origin = await run({ cwd: root, args: ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], codes: [1, 128], read: true })
  const named = origin.code === 0 ? origin.stdout.toString("utf8").trim().replace(/^origin\//, "") : ""
  if (named) return named
  const configured = await run({ cwd: root, args: ["config", "--get", "init.defaultBranch"], codes: [1], read: true })
  const candidates = [...new Set([configured.stdout.toString("utf8").trim(), "main", "master"].filter(Boolean))]
  const refs = candidates.flatMap((name) => [`refs/heads/${name}`, `refs/remotes/origin/${name}`])
  const listed = await run({ cwd: root, args: ["for-each-ref", "--format=%(refname)", ...refs], read: true })
  const present = new Set(listed.stdout.toString("utf8").split("\n").filter(Boolean))
  return candidates.find((name) => present.has(`refs/heads/${name}`) || present.has(`refs/remotes/origin/${name}`)) ?? null
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
