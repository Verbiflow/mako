import type { WorktreeStanding, WorktreeStartPoint } from "./contracts/thread-worktrees.js"
import { git, run, succeeds } from "@mako/git"

/** A fetch younger than this answers for the next one. */
const FETCH_EVERY_MS = 60_000
/** A remote that hasn't answered by now is treated as unreachable; the start uses what was fetched before. */
const FETCH_TIMEOUT_MS = 15_000

/** `git fetch` that never asks for credentials and gives up after the timeout. */
export async function fetchQuietly(repoRoot: string, args: string[]): Promise<void> {
  await run({ cwd: repoRoot, args: ["fetch", "--quiet", "--no-tags", ...args], timeoutMs: FETCH_TIMEOUT_MS })
}

interface Fetch {
  at: number
  failed: string | null
  running?: Promise<void>
}

/**
 * Where a new Thread's branch starts in a repository, and the background
 * fetch that keeps the project folder's upstream current for it. The fetch
 * runs at most once a minute per upstream and never asks for credentials;
 * a start reads the refs as they are and never waits on the network.
 */
export class WorktreeStarts {
  private readonly fetches = new Map<string, Fetch>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** `fetch` refreshes the upstream first when its last fetch is a minute old, waiting no longer than the fetch's timeout. */
  async point(repoRoot: string, fetch: boolean): Promise<WorktreeStartPoint> {
    const branch = await git(repoRoot, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "")
    if (!branch) {
      const commit = await git(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"])
      return { from: commit.slice(0, 7), commit, branch: null, upstream: null, standing: { kind: "detached" }, fetched: null }
    }
    const tracked = await this.tracked(repoRoot, branch)
    if (fetch && tracked) await this.fetch(repoRoot, tracked)
    const upstream = await git(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => "")
    const fetched = tracked ? this.fetched(repoRoot, tracked) : null
    if (!upstream || !(await succeeds(repoRoot, ["rev-parse", "--verify", "--quiet", `${upstream}^{commit}`]))) {
      const commit = await git(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"])
      return { from: branch, commit, branch, upstream: null, standing: { kind: "alone" }, fetched }
    }
    const [ahead = 0, behind = 0] = (await git(repoRoot, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`])).split(/\s+/).map(Number)
    const standing: WorktreeStanding = ahead && behind ? { kind: "diverged", ahead, behind }
      : ahead ? { kind: "ahead", ahead }
      : behind ? { kind: "behind", behind }
      : { kind: "level" }
    const from = standing.kind === "behind" ? upstream : branch
    const commit = await git(repoRoot, ["rev-parse", "--verify", `${standing.kind === "behind" ? upstream : "HEAD"}^{commit}`])
    return { from, commit, branch, upstream, standing, fetched }
  }

  /** The remote and branch `branch` pulls from, when that is another repository. */
  async tracked(repoRoot: string, branch: string): Promise<{ remote: string; ref: string } | null> {
    if (!branch) return null
    const [remote, ref] = await Promise.all([
      git(repoRoot, ["config", "--get", `branch.${branch}.remote`]).catch(() => ""),
      git(repoRoot, ["config", "--get", `branch.${branch}.merge`]).catch(() => ""),
    ])
    return remote && remote !== "." && ref ? { remote, ref } : null
  }

  private fetched(repoRoot: string, tracked: { remote: string; ref: string }): WorktreeStartPoint["fetched"] {
    const last = this.fetches.get(`${repoRoot}\0${tracked.remote}\0${tracked.ref}`)
    return last && last.at ? { at: last.at, failed: last.failed } : null
  }

  private async fetch(repoRoot: string, tracked: { remote: string; ref: string }): Promise<void> {
    const key = `${repoRoot}\0${tracked.remote}\0${tracked.ref}`
    const last = this.fetches.get(key)
    if (last?.running) return last.running
    if (last && this.now() - last.at < FETCH_EVERY_MS) return
    const entry: Fetch = { at: last?.at ?? 0, failed: last?.failed ?? null }
    entry.running = fetchQuietly(repoRoot, [tracked.remote, tracked.ref]).then(
      () => {
        entry.failed = null
      },
      () => {
        entry.failed = `Couldn't reach ${tracked.remote}; using what was fetched last.`
      },
    ).finally(() => {
      entry.at = this.now()
      delete entry.running
    })
    this.fetches.set(key, entry)
    return entry.running
  }
}
