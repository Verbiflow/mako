import { join } from "node:path"
import type { WorktreeStanding, WorktreeStartPoint } from "../contracts/thread-worktrees.js"
import { commonDirOf, fileStamp, gitFileText, parseGitConfig, personalGitConfigFiles, storedRef, type Git } from "@mako/git"
import { locateGitDir } from "../base/checkout-location.js"
import type { HeldPoint } from "./worktree-summary-cache.js"

/** A fetch younger than this answers for the next one. */
const FETCH_EVERY_MS = 60_000
/** A remote that hasn't answered by now is treated as unreachable; the start uses what was fetched before. */
const FETCH_TIMEOUT_MS = 15_000

/** `git fetch` that never asks for credentials and gives up after the timeout. */
export async function fetchQuietly(git: Git, repoRoot: string, args: string[]): Promise<void> {
  await git.run({ cwd: repoRoot, args: ["fetch", "--quiet", "--no-tags", ...args], timeoutMs: FETCH_TIMEOUT_MS })
}

/** Each repository's start point as last read, with what it was read at; a host hands in the one it keeps between starts. */
export interface HeldPoints {
  get(repoRoot: string): HeldPoint | undefined
  set(repoRoot: string, point: HeldPoint): void
}

/** What a point was read at, and the upstream ref among it; null when its branch has none. */
interface PointKey {
  key: string
  upstream: string | null
}

type Tracked = { remote: string; ref: string }

interface PointRead {
  point: WorktreeStartPoint
  tracked: Tracked | null
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
 *
 * A point is read once for what it depends on (`pointKey`): the main checkout's HEAD, its branch's commit, its
 * upstream's, and the configuration that names the upstream. All of those are in Git's files, so asking again while
 * none moved starts no process. Read by seven processes on every summaries pass and every event, a hundred worktrees
 * of two repositories kept Git reading what hadn't changed.
 */
export class WorktreeStarts {
  private readonly fetches = new Map<string, Fetch>()
  private readonly git: Git
  private readonly now: () => number
  private readonly held: HeldPoints
  /** Reads under way, by repository and key: those who ask while one runs share it. */
  private readonly reading = new Map<string, Promise<WorktreeStartPoint>>()
  /** The branch the person chose for the repository's new Threads in Settings › Projects, if they did. */
  private readonly chosen: (repoRoot: string) => Promise<string | undefined>

  constructor(git: Git, now: () => number = Date.now, held: HeldPoints = new Map(), chosen: (repoRoot: string) => Promise<string | undefined> = async () => undefined) {
    this.git = git
    this.now = now
    this.held = held
    this.chosen = chosen
  }

  /**
   * Where a new Thread's branch starts: the branch the person chose for the project when it's there, else Mako's own
   * rule (`automatic`). `fetch` refreshes what it starts from first when its last fetch is a minute old, waiting no
   * longer than the fetch's timeout.
   */
  async point(repoRoot: string, fetch: boolean): Promise<WorktreeStartPoint> {
    const base = await this.chosen(repoRoot).catch(() => undefined)
    const chosen = base ? await this.chosenPoint(repoRoot, base, fetch).catch(() => undefined) : undefined
    return chosen ?? this.automatic(repoRoot, fetch)
  }

  /** Whether `ref` names a commit in the repository. */
  async resolves(repoRoot: string, ref: string): Promise<boolean> {
    return (await this.commitOf(repoRoot, ref)) !== undefined
  }

  /**
   * The chosen branch's commit, read from Git's files where they hold it (a local branch, then a remote one), so a
   * summaries pass starts no process for it; undefined when the repository has no such branch, and Mako's rule applies.
   * A remote branch is fetched first, as an upstream is.
   */
  private async chosenPoint(repoRoot: string, base: string, fetch: boolean): Promise<WorktreeStartPoint | undefined> {
    const remote = await this.remoteOf(repoRoot, base)
    const tracked = remote ? { remote, ref: `refs/heads/${base.slice(remote.length + 1)}` } : null
    if (fetch && tracked) await this.fetch(repoRoot, tracked)
    const commit = await this.commitOf(repoRoot, base)
    if (!commit) return undefined
    return { from: base, commit, branch: null, upstream: null, standing: { kind: "level" }, fetched: tracked ? this.fetched(repoRoot, tracked) : null }
  }

  /** The remote `ref` is a branch of (`origin` for `origin/main`), when there's no local branch of that name. */
  private async remoteOf(repoRoot: string, ref: string): Promise<string | undefined> {
    const common = commonDirOf(repoRoot)
    if (await storedRef(common, `refs/heads/${ref}`).catch(() => undefined)) return undefined
    const slash = ref.indexOf("/")
    if (slash < 1) return undefined
    const config = parseGitConfig((await gitFileText(join(common, "config")).catch(() => undefined)) ?? "")
    const remote = ref.slice(0, slash)
    return config.has(`remote.${remote}.url`) ? remote : undefined
  }

  private async commitOf(repoRoot: string, ref: string): Promise<string | undefined> {
    const common = commonDirOf(repoRoot)
    let unknown = false
    for (const full of [`refs/heads/${ref}`, `refs/remotes/${ref}`]) {
      const stored = await storedRef(common, full).catch(() => undefined)
      if (stored) return stored
      if (stored === undefined) unknown = true
    }
    // Git's files say neither branch is there: no process asked. Only what they can't say (a reftable, a tag, a
    // commit) is asked of Git.
    if (!unknown && /^[\w./-]+$/.test(ref) && !/^[0-9a-f]{7,64}$/.test(ref)) return undefined
    const read = await this.git.readOutput(repoRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]).catch(() => "")
    return read || undefined
  }

  /** Where a new Thread's branch starts by Mako's own rule, whatever the person chose: see the class's comment. */
  async automatic(repoRoot: string, fetch: boolean): Promise<WorktreeStartPoint> {
    const at = await this.pointKey(repoRoot).catch(() => undefined)
    const key = at?.key
    const known = this.held.get(repoRoot)
    const current = at && known?.key === key ? known : undefined
    if (fetch) {
      const tracked = current ? current.tracked : await this.tracked(repoRoot, await this.git.readOutput(repoRoot, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => ""))
      if (tracked) await this.fetch(repoRoot, tracked)
      // The fetch may have moved the upstream: the point is whatever the refs say now.
      return this.automatic(repoRoot, false)
    }
    if (current) return { ...current.point, fetched: current.tracked ? this.fetched(repoRoot, current.tracked) : null }
    if (!at || key === undefined) return (await this.read(repoRoot)).point
    const sharing = `${repoRoot}\0${key}`
    let reading = this.reading.get(sharing)
    if (!reading) {
      reading = this.read(repoRoot).then(async ({ point, tracked }) => {
        // Kept only when nothing it depends on moved while it was read, and its upstream is the ref the key watches.
        const watched = point.upstream === null || at.upstream === `refs/remotes/${point.upstream}` || at.upstream === `refs/heads/${point.upstream}`
        if (watched && (await this.pointKey(repoRoot).catch(() => undefined))?.key === key) {
          // Without when it was last fetched, which is this host's to say each time it answers.
          this.held.set(repoRoot, { key, point: { from: point.from, commit: point.commit, branch: point.branch, upstream: point.upstream, standing: point.standing }, tracked })
        }
        return point
      }).finally(() => this.reading.delete(sharing))
      this.reading.set(sharing, reading)
    }
    return reading
  }

  /**
   * What a start point depends on, from Git's files: the main checkout's HEAD, the commit of the branch it names, the
   * upstream its configuration gives that branch and that ref's commit, and the configuration files' stamps. Undefined
   * when the files can't say (no commit yet, a reftable repository), and Git is asked every time.
   */
  private async pointKey(repoRoot: string): Promise<PointKey | undefined> {
    const gitDir = await locateGitDir(repoRoot)
    if (!gitDir) return undefined
    const common = commonDirOf(repoRoot)
    const [head, config, ...stamps] = await Promise.all([
      gitFileText(join(gitDir, "HEAD")),
      gitFileText(join(common, "config")),
      ...[join(common, "config"), ...personalGitConfigFiles()].map((file) => fileStamp(file)),
    ])
    if (!head || config === undefined) return undefined
    if (!head.startsWith("ref: refs/heads/")) return /^[0-9a-f]{40,64}$/.test(head) ? { key: JSON.stringify([head, null, null, null, stamps]), upstream: null } : undefined
    const branch = head.slice("ref: refs/heads/".length)
    const tip = await storedRef(common, `refs/heads/${branch}`)
    if (!tip) return undefined
    const values = parseGitConfig(config ?? "")
    const remote = values.get(`branch.${branch}.remote`)?.at(-1)
    const merge = values.get(`branch.${branch}.merge`)?.at(-1)
    const upstream = remote && merge?.startsWith("refs/heads/") ? remote === "." ? merge : `refs/remotes/${remote}/${merge.slice("refs/heads/".length)}` : null
    const commit = upstream ? await storedRef(common, upstream) : null
    if (commit === undefined) return undefined
    return { key: JSON.stringify([head, tip, upstream, commit, stamps]), upstream }
  }

  private async read(repoRoot: string): Promise<PointRead> {
    const read = (args: string[]) => this.git.readOutput(repoRoot, args)
    const branch = await read(["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "")
    if (!branch) {
      const commit = await read(["rev-parse", "--verify", "HEAD^{commit}"])
      return { point: { from: commit.slice(0, 7), commit, branch: null, upstream: null, standing: { kind: "detached" }, fetched: null }, tracked: null }
    }
    const tracked = await this.tracked(repoRoot, branch)
    const upstream = await read(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => "")
    const fetched = tracked ? this.fetched(repoRoot, tracked) : null
    if (!upstream || !(await read(["rev-parse", "--verify", "--quiet", `${upstream}^{commit}`]).then(Boolean, () => false))) {
      const commit = await read(["rev-parse", "--verify", "HEAD^{commit}"])
      return { point: { from: branch, commit, branch, upstream: null, standing: { kind: "alone" }, fetched }, tracked }
    }
    const [ahead = 0, behind = 0] = (await read(["rev-list", "--left-right", "--count", `HEAD...${upstream}`])).split(/\s+/).map(Number)
    const standing: WorktreeStanding = ahead && behind ? { kind: "diverged", ahead, behind }
      : ahead ? { kind: "ahead", ahead }
      : behind ? { kind: "behind", behind }
      : { kind: "level" }
    const from = standing.kind === "behind" ? upstream : branch
    const commit = await read(["rev-parse", "--verify", `${standing.kind === "behind" ? upstream : "HEAD"}^{commit}`])
    return { point: { from, commit, branch, upstream, standing, fetched }, tracked }
  }

  /** The remote and branch `branch` pulls from, when that is another repository. */
  async tracked(repoRoot: string, branch: string): Promise<{ remote: string; ref: string } | null> {
    if (!branch) return null
    const [remote, ref] = await Promise.all([
      this.git.readOutput(repoRoot, ["config", "--get", `branch.${branch}.remote`]).catch(() => ""),
      this.git.readOutput(repoRoot, ["config", "--get", `branch.${branch}.merge`]).catch(() => ""),
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
    entry.running = fetchQuietly(this.git, repoRoot, [tracked.remote, tracked.ref]).then(
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
