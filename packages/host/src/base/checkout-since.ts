import { hostExecFile } from "./host-command.js"
import { existsSync, readdirSync, realpathSync } from "node:fs"
import { lstat } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import type { BranchChanges, RepositoryChanges } from "../contracts/resume-account.js"

/**
 * What moved in a checkout after `since` (epoch ms), read from what Git and
 * the file system already keep: each repository's HEAD reflog (commits,
 * resets, checkouts), its branch's remote-tracking reflogs (pushes), and the
 * modification times of the files `git status` lists, with those the new
 * commits touched. Nothing is recorded ahead of time, so asking costs only
 * when something needs the answer. `folder` is a repository, or a project
 * folder whose repositories are its direct subfolders.
 */
export async function checkoutSince(given: string, since: number, options: { files?: number } = {}): Promise<RepositoryChanges[]> {
  const folder = real(given)
  const repositories = await repositoriesOf(folder)
  const changes = await Promise.all(repositories.map((repository) => repositorySince(folder, repository, since, options.files ?? 40)))
  return changes.filter((change): change is RepositoryChanges => change !== undefined)
}

/**
 * Where each repository's branch stands now against the branch it goes into
 * (`origin/HEAD`, else `origin/main`, as last fetched): its uncommitted files,
 * how far ahead and behind it is, and the commits that landed there after
 * `since` touching files the branch changed. Nothing is fetched.
 */
export async function branchSince(given: string, since: number): Promise<BranchChanges[]> {
  const folder = real(given)
  const repositories = await repositoriesOf(folder)
  return Promise.all(repositories.map((repository) => branchOf(folder, repository, since)))
}

/** A folder as Git names it (`/private/var` for `/var` on macOS), so repositories are named relative to it. */
function real(folder: string): string {
  try {
    return realpathSync(folder)
  } catch {
    return folder
  }
}

const GIT_TIMEOUT_MS = 10_000

function git(cwd: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    hostExecFile(
      "git",
      ["-c", "core.quotePath=false", ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout) => resolve(error ? undefined : stdout),
    )
  })
}

async function repositoriesOf(folder: string): Promise<string[]> {
  const top = (await git(folder, ["rev-parse", "--show-toplevel"]))?.trim()
  if (top) return [top]
  let entries: string[]
  try {
    entries = readdirSync(folder)
  } catch {
    return []
  }
  return entries.filter((entry) => !entry.startsWith(".") && existsSync(join(folder, entry, ".git"))).map((entry) => join(folder, entry))
}

interface ReflogEntry {
  at: number
  sha: string
  subject: string
}

/** A ref's reflog, newest first: when each move happened (seconds, as Git keeps them), where it went, and why. */
async function reflog(cwd: string, ref: string): Promise<ReflogEntry[]> {
  const out = await git(cwd, ["log", "-g", "--date=unix", "--format=%gd%x1f%H%x1f%gs", "-n", "200", ref, "--"])
  if (!out) return []
  const entries: ReflogEntry[] = []
  for (const line of out.split("\n")) {
    const [selector, sha, subject] = line.split("\x1f")
    const at = /@\{(\d+)\}$/.exec(selector ?? "")?.[1]
    if (at && sha) entries.push({ at: Number(at) * 1000, sha, subject: subject ?? "" })
  }
  return entries
}

/** Where a ref stood at `since` and the moves after it, oldest first; `undefined` when it never moved after. */
async function movesSince(cwd: string, ref: string, since: number): Promise<{ from?: string; to: string; moves: ReflogEntry[] } | undefined> {
  const entries = await reflog(cwd, ref)
  // The reflog keeps whole seconds: a move in the same second as `since` counts as after it.
  const after = entries.filter((entry) => entry.at >= Math.floor(since / 1000) * 1000)
  if (!after.length) return undefined
  const before = entries[after.length]
  return { from: before?.sha, to: after[0]!.sha, moves: after.reverse() }
}

async function repositorySince(checkout: string, repository: string, since: number, maxFiles: number): Promise<RepositoryChanges | undefined> {
  const name = relative(checkout, repository) || "."
  const branch = (await git(repository, ["symbolic-ref", "-q", "--short", "HEAD"]))?.trim()
  const head = await movesSince(repository, "HEAD", since)
  const commits: RepositoryChanges["commits"] = []
  const files = new Set<string>()
  if (head) {
    const range = head.from ? `${head.from}..${head.to}` : head.to
    const log = await git(repository, ["log", "--format=%H%x1f%s", "-n", "20", range, "--"])
    for (const line of log?.split("\n") ?? []) {
      const [sha, subject] = line.split("\x1f")
      if (sha) commits.push({ sha, subject: subject ?? "" })
    }
    if (head.from) for (const path of (await git(repository, ["diff", "--name-only", "-z", head.from, head.to, "--"]))?.split("\0") ?? []) if (path) files.add(path)
  }
  const remotes: RepositoryChanges["remotes"] = []
  if (branch) {
    const refs = (await git(repository, ["for-each-ref", "--format=%(refname)", "refs/remotes/"]))?.split("\n") ?? []
    for (const ref of refs.filter((each) => each.endsWith(`/${branch}`))) {
      const moved = await movesSince(repository, ref, since)
      if (moved) remotes.push({ ref: ref.replace(/^refs\/remotes\//, ""), from: moved.from, to: moved.to, how: moved.moves.map((move) => move.subject).join("; ") })
    }
  }
  for (const path of await filesTouchedSince(repository, since)) files.add(path)
  const listed = [...files].sort()
  if (!head && !remotes.length && !listed.length) return undefined
  return {
    name,
    ...(head && { head: { ...(head.from && { from: head.from }), to: head.to, moves: head.moves.map((move) => move.subject) } }),
    commits,
    remotes,
    files: listed.slice(0, maxFiles).map((path) => (name === "." ? path : join(name, path))),
    moreFiles: Math.max(0, listed.length - maxFiles),
  }
}

/**
 * Paths `git status` lists that changed at or after `since`: by their own
 * modification time, or for a deleted path, its folder's (a deletion moves
 * the folder's time).
 */
async function filesTouchedSince(repository: string, since: number): Promise<string[]> {
  const out = await git(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  if (!out) return []
  const records = out.split("\0")
  const paths: string[] = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!
    if (record.length < 4) continue
    const status = record.slice(0, 2)
    paths.push(record.slice(3))
    // A rename or copy is followed by its old path, which no longer exists.
    if (status.includes("R") || status.includes("C")) index++
  }
  const touched = await Promise.all(
    paths.map(async (path) => {
      const full = join(repository, path)
      const stat = await lstat(full).catch(() => undefined)
      if (stat) return stat.mtimeMs >= since ? path : undefined
      const folder = await lstat(dirname(full)).catch(() => undefined)
      return !folder || folder.mtimeMs >= since ? path : undefined
    }),
  )
  return touched.filter((path): path is string => path !== undefined)
}

async function branchOf(checkout: string, repository: string, since: number): Promise<BranchChanges> {
  const name = relative(checkout, repository) || "."
  const branch = (await git(repository, ["symbolic-ref", "-q", "--short", "HEAD"]))?.trim() || undefined
  const status = await git(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  const uncommitted = status ? status.split("\0").filter((record) => record.length >= 4 && !/^[RC]/.test(record)).length : 0
  const ref = await baseRef(repository)
  if (!ref || (branch && ref.endsWith(`/${branch}`))) return { name, ...(branch && { branch }), uncommitted }
  const counts = (await git(repository, ["rev-list", "--left-right", "--count", `HEAD...${ref}`]))?.trim().split(/\s+/)
  const base = (await git(repository, ["merge-base", "HEAD", ref]))?.trim()
  const changed = base ? ((await git(repository, ["diff", "--name-only", "-z", base, "HEAD", "--"]))?.split("\0").filter(Boolean) ?? []) : []
  const touching: NonNullable<BranchChanges["base"]>["touching"] = []
  if (changed.length) {
    const log = await git(repository, ["log", "--format=%x1e%H%x1f%s", "--name-only", `--since=@${Math.floor(since / 1000)}`, "-n", "10", base ? `${base}..${ref}` : ref, "--", ...changed])
    for (const record of log?.split("\x1e") ?? []) {
      const [head, ...files] = record.trim().split("\n")
      const [sha, subject] = (head ?? "").split("\x1f")
      if (sha) touching.push({ sha, subject: subject ?? "", files: files.filter(Boolean).map((path) => (name === "." ? path : join(name, path))) })
    }
  }
  return {
    name,
    ...(branch && { branch }),
    uncommitted,
    base: { ref: ref.replace(/^refs\/remotes\//, ""), ahead: Number(counts?.[0] ?? 0), behind: Number(counts?.[1] ?? 0), touching },
  }
}

/** The branch work here goes into: the remote's default (`origin/HEAD`), else `origin/main`; undefined when neither is known. */
async function baseRef(repository: string): Promise<string | undefined> {
  const head = (await git(repository, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]))?.trim()
  if (head) return head
  return (await git(repository, ["rev-parse", "-q", "--verify", "refs/remotes/origin/main"])) ? "refs/remotes/origin/main" : undefined
}
