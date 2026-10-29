import { fastForward, GitError, type Git } from "@mako/git"
import {
  CHANGE_TITLES,
  UNCOMMITTED_LISTED,
  UncommittedChangesSchema,
  type RevisionChanges,
  type UncommittedChanges,
  type UncommittedFile,
  type UpdateSource,
  type UpdateSourcePlan,
} from "../contracts/app-lifecycle.js"

/**
 * Where a local build's source checkout stands against the upstream updates
 * come from: the remote's default branch, fetched first.
 *
 * A build used to take whatever the checkout had checked out. A checkout 21
 * commits behind `origin/main` built and installed the revision already
 * running, and the update read as done. Every build now reads this first:
 * a checkout on the branch that tracks the upstream, behind it and with no
 * changes to tracked files, is fast-forwarded; anything else is built as it
 * is and the reading says why. The CLI (`update-local.mjs`) reads the same.
 */

/** A remote that hasn't answered by now is treated as unreachable; the reading uses what was fetched before. */
export const SOURCE_FETCH_TIMEOUT_MS = 15_000

type Checkout = Extract<UpdateSource, { kind: "checkout" }>

export interface ReadSourceOptions {
  /** Fetch the upstream before comparing. */
  fetch: boolean
  /** The running build's revision, and whether it carried uncommitted changes. */
  installed: { revision: string | null; dirty: boolean } | null
  signal?: AbortSignal
}

const lines = (text: string) => text.split("\n").filter(Boolean)

/** The checkout at `root` against its remote's default branch; a folder Git can't read says why. */
export async function readUpdateSource(git: Git, root: string, options: ReadSourceOptions): Promise<UpdateSource> {
  const repository = await git.openRepository(root, options.signal).catch(() => null)
  if (!repository) return { kind: "unreadable", reason: `${root} isn't a Git checkout, so Mako can't tell which revision it holds.` }
  const run = (args: string[], codes?: number[]) =>
    git.run({ cwd: root, args, codes, read: true, signal: options.signal }).then((result) => result.code === 0 ? result.stdout.toString("utf8").trim() : null)
  const head = await run(["rev-parse", "--verify", "-q", "HEAD^{commit}"], [1])
  if (!head) return { kind: "unreadable", reason: `${root} has no commits yet.` }
  const branch = await run(["symbolic-ref", "-q", "--short", "HEAD"], [1])
  const remote = await homeRemote(run, branch)
  let fetch: Checkout["fetch"] = { kind: "skipped" }
  let name = remote ? await remoteDefault(run, remote) : null
  if (remote && options.fetch) {
    fetch = await fetchUpstream(git, root, remote, name?.slice(remote.length + 1) ?? null, options.signal)
    name ??= await remoteDefault(run, remote)
  }
  const upstreamCommit = name ? await run(["rev-parse", "--verify", "-q", `refs/remotes/${name}^{commit}`], [1]) : null
  const tracking = upstreamCommit && name ? await trackingBranch(run, name) : null
  const upstream = upstreamCommit && name ? { name, commit: upstreamCommit, branch: tracking } : null
  const [counts, files] = await Promise.all([
    upstream ? run(["rev-list", "--left-right", "--count", `HEAD...${upstream.commit}`]) : Promise.resolve("0 0"),
    uncommittedFiles(git, root, options.signal),
  ])
  const [ahead = 0, behind = 0] = (counts ?? "0 0").split(/\s+/).map(Number)
  const untracked = files.filter((file) => file.change === "untracked").length
  const changed = files.length - untracked
  const plan = planFor({ head, branch, upstream, ahead, behind, changed, untracked }, options.installed)
  const target = plan.kind === "fast-forward" && upstream ? upstream.commit : head
  const changes = options.installed?.revision ? await changesSince(git, root, options.installed.revision, target, options.signal) : null
  return { kind: "checkout", head, branch, upstream, ahead, behind, changed, untracked, uncommitted: listed(files), fetch, plan, target, changes, readAt: new Date().toISOString() }
}

/**
 * Every file in the checkout at `root` with changes Git hasn't committed,
 * untracked files Git doesn't ignore included, in `git status` order: tracked
 * changes, then untracked files. A staged rename is one file, named with
 * where it came from.
 */
async function uncommittedFiles(git: Git, root: string, signal?: AbortSignal): Promise<UncommittedFile[]> {
  // NUL-separated, so a path is never quoted; a rename is `XY to\0from\0`.
  const { stdout } = await git.run({ cwd: root, args: ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--renames"], read: true, timeoutMs: 30_000, signal })
  const fields = stdout.toString("utf8").split("\0")
  const files: UncommittedFile[] = []
  for (let at = 0; at < fields.length; at++) {
    const entry = fields[at]!
    if (entry.length < 4) continue
    const [x, y, path] = [entry[0]!, entry[1]!, entry.slice(3)]
    if (x === "R" || y === "R" || x === "C" || y === "C") {
      const from = fields[++at] ?? ""
      files.push(x === "R" || y === "R" ? { path, change: "renamed", from } : { path, change: "added" })
      continue
    }
    const change: UncommittedFile["change"] = x === "?" ? "untracked"
      : x === "U" || y === "U" || (x === y && (x === "A" || x === "D")) ? "conflicted"
      : x === "D" || y === "D" ? "deleted"
      : x === "A" ? "added"
      : "edited"
    files.push({ path, change })
  }
  return files
}

const listed = (files: UncommittedFile[]): UncommittedChanges => ({ count: files.length, files: files.slice(0, UNCOMMITTED_LISTED) })

/** The checkout's uncommitted files, named: what a build of it as it is takes beyond its revision. */
export async function readUncommitted(git: Git, root: string, signal?: AbortSignal): Promise<UncommittedChanges> {
  return listed(await uncommittedFiles(git, root, signal))
}

/**
 * How an updater hands a build what it read with `readUncommitted`:
 * `package-mac.mjs` stamps it into the bundle's `makoBuild`, so the
 * installed app names the same files the updater named before building.
 */
export const BUILD_UNCOMMITTED_VARIABLE = "MAKO_BUILD_UNCOMMITTED"

/**
 * What `package-mac.mjs` stamps beside the revision: the updater's own
 * reading when it passed one; only `dirty` from an updater that passes
 * `MAKO_BUILD_DIRTY` alone (one released before the list, or a private copy
 * with no history to read); otherwise the checkout at `root`, read now.
 */
export async function buildUncommitted(env: NodeJS.ProcessEnv, read: () => Promise<UncommittedChanges>): Promise<{ dirty: boolean; uncommitted?: UncommittedChanges }> {
  const passed = env[BUILD_UNCOMMITTED_VARIABLE]
  const uncommitted = passed !== undefined ? UncommittedChangesSchema.parse(JSON.parse(passed))
    : env.MAKO_BUILD_DIRTY !== undefined ? null
    : await read()
  if (!uncommitted) return { dirty: env.MAKO_BUILD_DIRTY === "1" }
  return uncommitted.count ? { dirty: true, uncommitted } : { dirty: false }
}

/**
 * The plan for a reading. A build that would carry exactly the installed,
 * clean revision is `current` when nothing newer can reach the checkout,
 * and an `as-is` marked `installed` when the upstream has more that it can't
 * take: either way there is nothing to build.
 */
export function planFor(
  reading: Pick<Checkout, "head" | "branch" | "upstream" | "ahead" | "behind" | "changed" | "untracked">,
  installed: ReadSourceOptions["installed"]
): UpdateSourcePlan {
  const { head, branch, upstream, ahead, behind, changed, untracked } = reading
  const home = upstream !== null && branch !== null && upstream.branch === branch
  const forward = home && behind > 0 && ahead === 0 && changed === 0
  const target = forward ? upstream.commit : head
  const dirty = forward ? untracked > 0 : changed + untracked > 0
  const same = Boolean(installed?.revision && !installed.dirty && !dirty && target.startsWith(installed.revision))
  if (same && (forward || !upstream || behind === 0)) return { kind: "current" }
  if (forward) return { kind: "fast-forward" }
  const why = !upstream ? "no-upstream"
    : !branch ? "detached"
    : !home ? "branch"
    : ahead && behind ? "diverged"
    : behind ? "changes"
    : ahead ? "ahead"
    : "level"
  return { kind: "as-is", why, installed: same }
}

/**
 * Brings the checkout to the reading's target when its plan is a
 * fast-forward, refusing if anything moved since it was read. Answers the
 * branch moved and from where, or null when there was nothing to do.
 */
export async function bringForward(git: Git, root: string, reading: UpdateSource, signal?: AbortSignal): Promise<{ branch: string; from: string; to: string } | null> {
  if (reading.kind !== "checkout" || reading.plan.kind !== "fast-forward" || !reading.branch) return null
  const repository = await git.openRepository(root, signal)
  if (!repository) throw new Error(`${root} isn't a Git checkout.`)
  try {
    await fastForward(repository, { branch: reading.branch, head: reading.head }, reading.target, signal)
  } catch (error) {
    const reason = error instanceof GitError && error.kind === "untracked_files"
      ? "untracked files there would be overwritten"
      : error instanceof Error ? error.message : String(error)
    throw new Error(`Couldn't bring ${reading.branch} up to ${reading.target.slice(0, 8)}: ${reason} Nothing in the checkout changed.`, { cause: error })
  }
  return { branch: reading.branch, from: reading.head, to: reading.target }
}

/** What `to` has that `from` doesn't, along first parents. `from` missing from the checkout counts from nothing known. */
export async function changesSince(git: Git, root: string, from: string, to: string, signal?: AbortSignal): Promise<RevisionChanges> {
  const known = (await git.run({ cwd: root, args: ["cat-file", "-e", `${from}^{commit}`], codes: [1, 128], read: true, signal })).code === 0
  if (!known) return { from: null, count: 0, titles: [] }
  if (from === to) return { from, count: 0, titles: [] }
  const range = `${from}..${to}`
  const [count, subjects] = await Promise.all([
    git.text({ cwd: root, args: ["rev-list", "--count", "--first-parent", range], read: true, signal }),
    git.text({ cwd: root, args: ["log", "--first-parent", `-${CHANGE_TITLES}`, "--format=%s", range, "--"], read: true, signal }),
  ])
  return { from, count: Number(count), titles: lines(subjects) }
}

type Read = (args: string[], codes?: number[]) => Promise<string | null>

/** The branch's own remote when it has one, else `origin`, else the only remote. */
async function homeRemote(run: Read, branch: string | null): Promise<string | null> {
  const remotes = lines((await run(["remote"])) ?? "")
  const own = branch ? await run(["config", "--get", `branch.${branch}.remote`], [1]) : null
  if (own && remotes.includes(own)) return own
  if (remotes.includes("origin")) return "origin"
  return remotes.length === 1 ? remotes[0]! : null
}

/** `origin/main`: what the remote's HEAD names, else its `main` or `master`. */
async function remoteDefault(run: Read, remote: string): Promise<string | null> {
  const named = await run(["symbolic-ref", "-q", "--short", `refs/remotes/${remote}/HEAD`], [1, 128])
  if (named) return named
  const listed = lines((await run(["for-each-ref", "--format=%(refname:short)", `refs/remotes/${remote}/main`, `refs/remotes/${remote}/master`])) ?? "")
  return listed.includes(`${remote}/main`) ? `${remote}/main` : listed[0] ?? null
}

/** The local branch whose upstream is `name`, preferring the one named the same. */
async function trackingBranch(run: Read, name: string): Promise<string | null> {
  const rows = lines((await run(["for-each-ref", "--format=%(refname:short) %(upstream:short)", "refs/heads"])) ?? "")
  const tracking = rows.flatMap((row) => {
    const [branch = "", upstream = ""] = row.split(" ")
    return upstream === name ? [branch] : []
  })
  const short = name.slice(name.indexOf("/") + 1)
  return tracking.includes(short) ? short : tracking[0] ?? null
}

/** Fetch the remote's default branch, never asking for credentials; an unreachable remote is a reason, not a failure. */
async function fetchUpstream(git: Git, root: string, remote: string, branch: string | null, signal?: AbortSignal): Promise<Checkout["fetch"]> {
  const refspec = branch ? [`+refs/heads/${branch}:refs/remotes/${remote}/${branch}`] : []
  try {
    await git.run({ cwd: root, args: ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--", remote, ...refspec], timeoutMs: SOURCE_FETCH_TIMEOUT_MS, signal })
    return { kind: "fetched" }
  } catch (error) {
    signal?.throwIfAborted()
    const reason = error instanceof GitError
      ? error.kind === "timeout" ? `${remote} didn't answer in ${SOURCE_FETCH_TIMEOUT_MS / 1000} seconds`
        : error.kind === "auth" ? `${remote} refused the sign-in`
        : (error.stderr.split("\n").find(Boolean) ?? error.message).replace(/^fatal: /, "")
      : String(error)
    return { kind: "failed", reason }
  }
}
