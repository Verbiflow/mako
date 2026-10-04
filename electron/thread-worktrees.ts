import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, matchesGlob, relative } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import type { ThreadStore } from "./thread-store.js"
import type { ThreadId } from "./contracts/thread-identity.js"
import { WORKTREE_BRANCH_PREFIX as BRANCH_PREFIX, worktreeSlug } from "./contracts/thread-worktrees.js"
import type { GitDiff } from "./contracts/git-workspace-search.js"
import type { ThreadWorktree, ThreadWorktrees as ThreadWorktreeList, WorktreeDetail, WorktreeInventory, WorktreeLanding, WorktreeBranch, WorktreeMergeCheck, WorktreeReview, WorktreeReviewFile, WorktreeStart, WorktreeStartPoint, WorktreeStep, WorktreeBranchPull, WorktreeSummary, WorktreeUpdate } from "./contracts/thread-worktrees.js"
import { inputsDigest, type PrepareStep } from "./thread-recipe.js"
import { carryFiles, carryOutputs, outputNames, ownBytes, removeBelowAgents, type CheckoutSetup, type OutputsCarry } from "./worktree-carry.js"
import { git, GitError, gitExecutable, mergesWithoutCheckout, PARALLEL_CHECKOUT, succeeds } from "./worktree-git.js"
import { setAside, WorktreeSpares, type Spare } from "./worktree-spares.js"
import { fetchQuietly, WorktreeStarts } from "./worktree-start.js"

const execute = promisify(execFile)
/** Git's own markers for work under way, which a removal would throw away. */
const UNDER_WAY: readonly (readonly [string, string])[] = [
  ["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"], ["BISECT_LOG", "bisect"],
]
const MAX_REMEMBERED_CARRIES = 64
/** A new Thread's branch search lists this many branches, the most recently committed. */
const LISTED_BRANCHES = 200
const BRANCH_PULLS_EVERY_MS = 60_000

/**
 * The pull request for `branch`: by its head branch, or by number for a
 * fork's pull request fetched as `pr-N`. An open one wins over a closed one;
 * otherwise the newest.
 */
function branchPull(pulls: readonly WorktreeBranchPull[], branch: string): WorktreeBranchPull | null {
  const number = /^pr-(\d+)$/.exec(branch)?.[1]
  const mine = pulls.filter((pull) => pull.branch === branch || (number !== undefined && pull.number === Number(number)))
  return mine.find((pull) => pull.state === "open" || pull.state === "draft") ?? mine[0] ?? null
}

const ReceiptSchema = z.object({
  conversation: z.string().uuid(),
  /** The folder the Thread was started from, resolved. */
  source: z.string(),
  repoRoot: z.string(),
  path: z.string(),
  cwd: z.string(),
  branch: z.string(),
  base: z.string(),
  state: z.enum(["creating", "ready"]),
  copied: z.number().optional(),
  tookMs: z.number().optional(),
  /** Taken from a checkout made ahead of time. */
  spare: z.boolean().optional(),
  /** What moving the source checkout's uncommitted changes here did, so a repeated request answers the same. */
  moved: z.union([z.object({ files: z.number() }), z.object({ stash: z.string() })]).optional(),
  /** Written before the changes are stashed, so a start cut short after that finds the stash and finishes the move. */
  moving: z.object({ stash: z.string(), files: z.number() }).optional(),
  /** The branch existed before the Thread: it works on it, and nothing Mako does deletes it. */
  adopted: z.literal(true).optional(),
  /** Where a new branch started, as a person reads it: `main`, `origin/main`, a short commit. */
  from: z.string().optional(),
})
type Receipt = z.infer<typeof ReceiptSchema>
type WorktreeFrom = { kind: "newest" } | { kind: "head" } | WorktreeStart

export interface PreparedWorktree {
  /** Where the conversation runs: the worktree, or the same subfolder in it the Thread was started from. */
  cwd: string
  path: string
  branch: string
  /** Files the recipe's `carry` names, copied from the main checkout. */
  copied: number
  tookMs: number
  /** Taken from a checkout made ahead of time rather than checked out on the send. */
  spare: boolean
}

/** What a review loads in full; the files past these are listed but not read. */
const REVIEW_FILES = 25
const REVIEW_BYTES = 512 * 1024
const REVIEW_FILE_BYTES = 256 * 1024
/** Untracked files whose lines a review counts; past this they are listed uncounted. */
const COUNTED_UNTRACKED = 200

/** `git diff --numstat -z -M`: a rename's record has an empty path, then the old and new paths. */
function parseNumstat(output: string): WorktreeReviewFile[] {
  const files: WorktreeReviewFile[] = []
  const fields = output.split("\0")[Symbol.iterator]()
  const count = (value: string) => value === "-" ? null : Number(value)
  for (const field of fields) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(field)
    if (!match) continue
    const [, added = "-", removed = "-", named = ""] = match
    const from = named ? undefined : fields.next().value
    const path = named || (fields.next().value ?? "")
    const file: WorktreeReviewFile = { path, insertions: count(added), deletions: count(removed) }
    if (from) file.from = from
    files.push(file)
  }
  return files
}

/** A text file's lines, or null for a binary or very large one. */
async function textLines(path: string): Promise<number | null> {
  const bytes = await readFile(path).catch(() => null)
  if (!bytes || bytes.length > REVIEW_FILE_BYTES * 4 || bytes.subarray(0, 8000).includes(0)) return null
  let lines = 0
  for (const byte of bytes) if (byte === 10) lines += 1
  return bytes.length && bytes.at(-1) !== 10 ? lines + 1 : lines
}

/** A file as Git has it at `revision`, byte for byte, or null when it isn't there. */
async function shown(cwd: string, revision: string, path: string): Promise<string | null> {
  return execute(gitExecutable(), ["show", `${revision}:${path}`], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).then(({ stdout }) => stdout, () => null)
}

/** `map` with at most `limit` running at once, results in order. */
/**
 * Why removing the worktree at `path` would lose work, if it would:
 * uncommitted files, a rebase or merge under way, or a detached HEAD on a
 * commit no branch or tag has. Anything committed on a branch stays with it.
 */
async function removalBlocker(path: string, status?: string): Promise<string | undefined> {
  const name = basename(path)
  let changes: string
  let gitDir: string
  try {
    ;[changes, gitDir] = await Promise.all([
      status ?? git(path, ["status", "--porcelain", "--untracked-files=normal"]),
      git(path, ["rev-parse", "--absolute-git-dir"]),
    ])
  } catch (error) {
    return `Git couldn't read ${name}: ${error instanceof Error ? error.message : String(error)}`
  }
  if (changes) return `${name} has changes that aren't committed. Commit or discard them, then remove the worktree.`
  const underWay = UNDER_WAY.find(([marker]) => existsSync(join(gitDir, marker)))
  if (underWay) return `${name} is in the middle of a ${underWay[1]}. Finish or abort it, then remove the worktree.`
  if (!(await succeeds(path, ["symbolic-ref", "-q", "HEAD"]))) {
    const kept = await git(path, ["for-each-ref", "--count=1", "--contains", "HEAD", "--format=%(refname)", "refs/heads", "refs/tags", "refs/remotes"]).catch(() => "")
    if (!kept) return `${name} is on a commit no branch has. Create a branch there, then remove the worktree.`
  }
  return undefined
}

async function mapLimited<T, R>(values: readonly T[], limit: number, map: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  // One iterator shared by every worker: each takes the next value as it frees up.
  const queue = values.entries()
  const worker = async () => {
    for (const [index, value] of queue) results[index] = await map(value)
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker))
  return results
}

/**
 * Worktrees for Threads that start in one. Each is a branch `mako/{slug}`
 * checked out under `{root}/{repo}-{hash}/{slug}`, made on the Thread's
 * first send and never on a read. A receipt per conversation makes a
 * repeated start find the worktree the first attempt made, including one
 * cut short between `git worktree add` and the copy.
 *
 * What else a new checkout gets from the main one is the project's recipe's
 * to say, not Mako's: the files its `carry` names, before the agent starts,
 * and its install steps' `outputs` in the background (`carryOutputs`).
 * Without a recipe, a worktree has what Git checks out and nothing more.
 *
 * The send takes a spare checkout when the project has one ready, and the
 * project's spares are topped up behind it (`WorktreeSpares`).
 */
/** A Worktree Thread's running app ends with its worktree: its processes stop before the folder goes, and its data after. */
export interface ThreadEnvironmentEnd {
  stop(thread: ThreadId): Promise<void>
  /** Runs the recipe's cleanup in the worktree, while it's still there under its own name. */
  cleanup?(thread: ThreadId, path: string): Promise<void>
  discard(thread: ThreadId, path: string): Promise<void>
}

export class ThreadWorktreeService {
  readonly root: string
  private readonly threads: ThreadStore
  private readonly inUse: (path: string) => Promise<string[]>
  private readonly working: (path: string) => Promise<string[]>
  private readonly environment: ThreadEnvironmentEnd | undefined
  private readonly setup: CheckoutSetup | undefined
  private readonly pending = new Map<string, Promise<Receipt>>()
  private readonly carrying = new Map<string, Promise<OutputsCarry>>()
  private readonly wanting = new Set<Promise<void>>()
  private readonly spares: WorktreeSpares
  private readonly starts = new WorktreeStarts()
  private readonly skips = new Map<string, () => void>()
  private readonly branchPulls = new Map<string, { at: number; pulls: Promise<WorktreeBranchPull[] | null> }>()

  /**
   * `inUse` names what is open inside a folder, conversations and shells;
   * `working`, the conversations there that are in the middle of a turn;
   * `environment`, what ends a Thread's running app with its worktree;
   * `setup`, the project's recipe and install records, for what a new
   * checkout takes from the main one.
   */
  constructor(
    root: string,
    threads: ThreadStore,
    inUse: (path: string) => Promise<string[]> = async () => [],
    working: (path: string) => Promise<string[]> = async () => [],
    environment?: ThreadEnvironmentEnd,
    setup?: CheckoutSetup,
  ) {
    this.root = root
    this.threads = threads
    this.inUse = inUse
    this.working = working
    this.environment = environment
    this.setup = setup
    this.spares = new WorktreeSpares(root, (repoRoot) => this.projectFolder(repoRoot), setup)
  }

  /**
   * `from`: `newest` starts a new Thread's branch where `startPoint` says;
   * `head`, at the folder's own commit, for a Thread whose uncommitted
   * changes move along and must apply where they were made; a
   * `WorktreeStart`, where the person chose.
   */
  prepare(conversationId: string, cwd: string, name: string | undefined, from: WorktreeFrom = { kind: "newest" }, onStep?: (step: WorktreeStep) => void): Promise<PreparedWorktree> {
    z.string().uuid().parse(conversationId)
    let work = this.pending.get(conversationId)
    if (!work) {
      work = this.create(conversationId, cwd, name, from, onStep)
      this.pending.set(conversationId, work)
      void work.finally(() => this.pending.delete(conversationId)).catch(() => {})
    }
    return work.then((receipt) => ({
      cwd: receipt.cwd,
      path: receipt.path,
      branch: receipt.branch,
      copied: receipt.copied ?? 0,
      tookMs: receipt.tookMs ?? 0,
      spare: receipt.spare ?? false,
    }))
  }

  /**
   * `making`, unless the person chose to start in the project folder while
   * it was being made: then undefined at once, and the worktree is given
   * back once its making finishes.
   */
  async unlessSkipped(conversationId: string, making: Promise<PreparedWorktree>): Promise<PreparedWorktree | undefined> {
    const skipped = new Promise<undefined>((resolve) => this.skips.set(conversationId, () => resolve(undefined)))
    try {
      const made = await Promise.race([making, skipped])
      if (!made) void making.then(() => this.abandon(conversationId), () => this.abandon(conversationId)).catch(() => {})
      return made
    } finally {
      this.skips.delete(conversationId)
    }
  }

  /** Start this conversation in its project folder instead of the worktree being made for it; nothing once it's made. */
  skip(conversationId: string): void {
    this.skips.get(conversationId)?.()
  }

  /**
   * A worktree for a fork of `sourceId` that joins the source's Thread. A
   * Thread has one worktree per device, so a Thread that has one already is
   * refused; a repeated request finds its first worktree.
   */
  async prepareFork(sourceId: string, forkId: string, cwd: string, name: string | undefined): Promise<PreparedWorktree> {
    if (!this.pending.has(forkId) && !(await this.receipt(forkId))) {
      const current = this.ofConversation(sourceId)
      if (current) throw new Error(`This Thread already works in its own worktree, on ${current.branch}. Move the Session into that one instead.`)
      const repoRoot = await git(await realpath(cwd), ["rev-parse", "--show-toplevel"]).catch(() => "")
      const busy = repoRoot ? await this.working(repoRoot) : []
      if (busy.length)
        throw new Error(`${busy.join(", ")} ${busy.length === 1 ? "is" : "are"} working in ${basename(repoRoot)}. Moving its changes would pull files from under ${busy.length === 1 ? "it" : "them"}; continue once ${busy.length === 1 ? "it stops" : "they stop"}.`)
    }
    return this.prepare(forkId, cwd, name, { kind: "head" })
  }

  /**
   * The branches a new Thread in this folder's project can start from or
   * work on, most recently committed first: local ones, and a remote's that
   * have no local branch of the same name.
   */
  async branches(cwd: string): Promise<WorktreeBranch[]> {
    const repoRoot = await realpath(cwd).then((source) => git(source, ["rev-parse", "--show-toplevel"])).catch(() => "")
    if (!repoRoot) return []
    const [listed, remotes] = await Promise.all([
      git(repoRoot, ["for-each-ref", "--sort=-committerdate", `--count=${LISTED_BRANCHES * 2}`, "--format=%(refname)%00%(committerdate:unix)%00%(worktreepath)", "refs/heads", "refs/remotes"]),
      git(repoRoot, ["remote"]).then((text) => text.split("\n").filter(Boolean)),
    ])
    const local = new Set<string>()
    const found: (WorktreeBranch & { short: string })[] = []
    for (const line of listed.split("\n")) {
      const [ref = "", at = "0", checkedOut = ""] = line.split("\0")
      const entry = { at: Number(at) * 1000, checkedOut: checkedOut || null }
      if (ref.startsWith("refs/heads/")) {
        const name = ref.slice("refs/heads/".length)
        local.add(name)
        found.push({ ...entry, name, short: name, remote: false })
        continue
      }
      const name = ref.slice("refs/remotes/".length)
      const remote = remotes.find((candidate) => name.startsWith(`${candidate}/`))
      const short = remote ? name.slice(remote.length + 1) : name
      if (short !== "HEAD") found.push({ ...entry, name, short, remote: true })
    }
    return found.filter((branch) => !branch.remote || !local.has(branch.short)).slice(0, LISTED_BRANCHES)
      .map(({ name, remote, at, checkedOut }) => ({ name, remote, at, checkedOut }))
  }

  /** Where a new Thread's branch in this folder's project would start now; null outside Git or before a first commit. */
  async startPoint(cwd: string, fetch: boolean): Promise<WorktreeStartPoint | null> {
    const repoRoot = await realpath(cwd).then((source) => git(source, ["rev-parse", "--show-toplevel"])).catch(() => "")
    if (!repoRoot) return null
    return this.starts.point(repoRoot, fetch).catch(() => null)
  }

  /**
   * Where a fork of `sourceId` works when the source's Thread has its
   * worktree already: the same folder inside it. Undefined when the Thread
   * has none, or when this fork made it, so a repeated request finishes the
   * way the first one started.
   */
  async joinFolder(sourceId: string, forkId: string, cwd: string): Promise<string | undefined> {
    if (this.pending.has(forkId) || (await this.receipt(forkId))) return undefined
    const current = this.ofConversation(sourceId)
    if (!current) return undefined
    const inside = relative(await realpath(current.repoRoot).catch(() => current.repoRoot), await realpath(cwd).catch(() => cwd))
    const folder = inside && !inside.startsWith("..") && !isAbsolute(inside) ? join(current.path, inside) : current.path
    return existsSync(folder) ? folder : current.path
  }

  /** The worktree of the Thread this conversation's journal joined, on this device. */
  ofConversation(conversationId: string): ThreadWorktree | undefined {
    const placed = this.threads.journalPlacement(conversationId)
    return placed ? this.threads.worktrees().find((worktree) => worktree.thread === placed.thread) : undefined
  }

  /**
   * The folder's project is about to start a worktree Thread (its composer
   * is set to Worktree): keep spares of it ready. Returns once recorded.
   */
  async want(cwd: string): Promise<void> {
    const repoRoot = await git(await realpath(cwd), ["rev-parse", "--show-toplevel"])
    if (await succeeds(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])) await this.spares.want(repoRoot)
  }

  /** At start: give back spares that are idle or were half-made by a host that died, and empty the trash. */
  async tidy(): Promise<void> {
    await this.spares.sweep()
  }

  /** Resolves once spares being made and outputs being cloned are in place. */
  async settled(): Promise<void> {
    await Promise.all([...this.wanting, ...this.carrying.values()])
    await this.spares.settled()
  }

  /**
   * Every worktree with what decides whether it can go: uncommitted files,
   * what runs there, whether its branch landed, and its own size. Sizes are
   * read in the background band, a few at a time.
   */
  async inventory(): Promise<WorktreeInventory> {
    const { worktrees } = await this.list()
    const attached = new Set(worktrees.map((worktree) => worktree.path))
    // Starts that failed or were cut short after their worktree was made: no Thread lists these.
    const loose = new Map<string, Omit<WorktreeDetail, "changes" | "held" | "landing" | "users" | "bytes">>()
    for (const { receipt, createdAt } of await this.receiptsList()) {
      if (receipt.state !== "ready" || attached.has(receipt.path) || !existsSync(join(receipt.path, ".git"))) continue
      const { path, repoRoot, branch, base } = receipt
      loose.set(path, { path, thread: null, repoRoot, project: receipt.source, branch, base, createdAt })
    }
    const skipped = new Map<string, Promise<string[]>>()
    const outputsOf = (repoRoot: string) => {
      let names = skipped.get(repoRoot)
      if (!names) skipped.set(repoRoot, names = (this.setup?.recipe(repoRoot) ?? Promise.resolve(undefined)).then(outputNames, () => []))
      return names
    }
    const detailed = await mapLimited([...worktrees, ...loose.values()], 4, async (worktree): Promise<WorktreeDetail> => {
      const [status, landing, users, bytes] = await Promise.all([
        git(worktree.path, ["status", "--porcelain", "--untracked-files=normal"]).catch(() => null),
        this.landing(worktree),
        this.inUse(worktree.path),
        outputsOf(worktree.repoRoot).then((names) => ownBytes(worktree.path, names)),
      ])
      const held = await removalBlocker(worktree.path, status ?? undefined) ?? null
      return { ...worktree, changes: status ? status.split("\n").length : 0, held, landing, users, bytes }
    })
    const spares = await this.spares.recorded()
    const spareBytes = await mapLimited(spares, 4, async (spare) => ownBytes(spare.path, await outputsOf(spare.repoRoot)))
    const known = spareBytes.filter((bytes) => bytes !== null)
    return { worktrees: detailed, spares: { count: spares.length, bytes: known.length ? known.reduce((sum, bytes) => sum + bytes, 0) : null } }
  }

  /**
   * Whether the branch's work is in the branch the main checkout is on. A
   * merge, a fast-forward and a rebase leave the branch's commits reachable;
   * a squash doesn't, so a branch whose merge would leave the target's tree
   * as it is has landed too.
   */
  private async landing(worktree: Pick<ThreadWorktree, "repoRoot" | "branch" | "base">): Promise<WorktreeLanding> {
    const into = await git(worktree.repoRoot, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "")
    if (!into) return { kind: "unknown" }
    try {
      const commits = Number(await git(worktree.repoRoot, ["rev-list", "--count", `${worktree.base}..${worktree.branch}`]))
      if (commits === 0) return { kind: "empty" }
      if (await succeeds(worktree.repoRoot, ["merge-base", "--is-ancestor", worktree.branch, into])) return { kind: "merged", into }
      // A squash merge shows only through an in-memory merge, which older Git can't do.
      if (!await mergesWithoutCheckout()) return { kind: "open", into, commits }
      const [merged, target] = await Promise.all([
        git(worktree.repoRoot, ["merge-tree", "--write-tree", into, worktree.branch]).catch(() => ""),
        git(worktree.repoRoot, ["rev-parse", `${into}^{tree}`]),
      ])
      return merged === target ? { kind: "merged", into } : { kind: "open", into, commits }
    } catch {
      return { kind: "unknown" }
    }
  }

  /**
   * How every worktree's branch stands: commits main doesn't have, uncommitted
   * files, whether it landed, and its pull request. `pullsOf` lists a
   * repository's pull requests, newest first, and is asked at most once a
   * minute per repository.
   */
  async summaries(pullsOf?: (repoRoot: string) => Promise<WorktreeBranchPull[] | null>): Promise<WorktreeSummary[]> {
    const { worktrees } = await this.list()
    const pullsIn = (repoRoot: string) => {
      const now = Date.now()
      const cached = this.branchPulls.get(repoRoot)
      if (cached && now - cached.at < BRANCH_PULLS_EVERY_MS) return cached.pulls
      const pulls = (pullsOf?.(repoRoot) ?? Promise.resolve(null)).catch(() => null)
      this.branchPulls.set(repoRoot, { at: now, pulls })
      return pulls
    }
    return mapLimited(worktrees, 4, async (worktree): Promise<WorktreeSummary> => {
      const [status, landing, into, tip, pulls] = await Promise.all([
        git(worktree.path, ["status", "--porcelain", "--untracked-files=normal"]).catch(() => ""),
        this.landing(worktree),
        git(worktree.repoRoot, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => ""),
        git(worktree.repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${worktree.branch}`]).catch(() => ""),
        pullsIn(worktree.repoRoot),
      ])
      const ahead = Number(await git(worktree.repoRoot, ["rev-list", "--count", into ? `${into}..${worktree.branch}` : `${worktree.base}..${worktree.branch}`]).catch(() => "0"))
      const pull = branchPull(pulls ?? [], worktree.branch)
      const squashedThere = landing.kind === "open" && pull?.state === "merged" && pull.head === tip
      return {
        path: worktree.path,
        into: into || null,
        ahead,
        changes: status ? status.split("\n").length : 0,
        landing: squashedThere ? { kind: "merged", into: landing.into } : landing,
        pull,
      }
    })
  }

  /** Commits on a worktree's branch since the commit it started at; undefined for a folder that isn't one of Mako's worktrees. */
  async ahead(path: string): Promise<number | undefined> {
    const worktree = this.threads.worktrees().find((entry) => entry.path === path)
    if (!worktree || !existsSync(path)) return undefined
    return Number(await git(path, ["rev-list", "--count", `${worktree.base}..HEAD`]))
  }

  private known(path: string): ThreadWorktree {
    const worktree = this.threads.worktrees().find((entry) => entry.path === path)
    if (!worktree || !existsSync(path)) throw new Error("Mako didn't make this worktree.")
    return worktree
  }

  /**
   * The worktree's work since it branched, committed and uncommitted, against
   * where it meets the branch the main checkout has out, and whether merging
   * it there is safe now.
   */
  async review(path: string): Promise<WorktreeReview> {
    const worktree = this.known(path)
    const into = await git(worktree.repoRoot, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "") || null
    const base = into ? await git(path, ["merge-base", into, "HEAD"]).catch(() => worktree.base) : worktree.base
    const [commits, numstat, untracked, status, behind] = await Promise.all([
      git(path, ["rev-list", "--count", `${base}..HEAD`]).then(Number),
      git(path, ["diff", "--numstat", "-z", "-M", base]),
      git(path, ["ls-files", "--others", "--exclude-standard", "-z"]),
      git(path, ["status", "--porcelain", "--untracked-files=normal"]),
      this.behind(worktree.repoRoot, path, false),
    ])
    const files = parseNumstat(numstat)
    const added = untracked.split("\0").filter(Boolean)
    const counted = await mapLimited(added.slice(0, COUNTED_UNTRACKED), 8, (file) => textLines(join(path, file)))
    added.forEach((file, index) => {
      const lines = counted[index] ?? null
      files.push({ path: file, insertions: lines, deletions: lines === null ? null : 0 })
    })
    return {
      path, branch: worktree.branch, into, base, commits, files,
      merge: await this.mergeCheck(worktree, into, commits, status !== ""),
      behind: behind && { from: behind.from, commits: behind.commits },
    }
  }

  /** What the start point has that the worktree's `HEAD` doesn't, by the same rule a new Thread starts by. */
  private async behind(repoRoot: string, path: string, fetch: boolean): Promise<{ from: string; commit: string; commits: number } | null> {
    try {
      const point = await this.starts.point(repoRoot, fetch)
      return { from: point.from, commit: point.commit, commits: Number(await git(path, ["rev-list", "--count", `HEAD..${point.commit}`])) }
    } catch {
      return null
    }
  }

  /**
   * Merge what the start point has into the worktree's branch. A worktree
   * with uncommitted changes, or mid-operation, is refused. A conflict
   * leaves the merge in progress, so the person or the Thread's agent can
   * resolve it, continue or abort it in the Changes panel.
   */
  async update(path: string): Promise<WorktreeUpdate> {
    const worktree = this.known(path)
    if (await git(path, ["status", "--porcelain", "--untracked-files=no"]).catch(() => "unreadable"))
      throw new Error("Commit or stash your changes first.")
    const gitDir = await git(path, ["rev-parse", "--absolute-git-dir"])
    const underWay = UNDER_WAY.find(([marker]) => existsSync(join(gitDir, marker)))
    if (underWay) throw new Error(`Finish or abort the ${underWay[1]} first.`)
    if (!(await succeeds(path, ["symbolic-ref", "-q", "HEAD"]))) throw new Error("The worktree isn't on its branch.")
    const behind = await this.behind(worktree.repoRoot, path, true)
    if (!behind) throw new Error("Git couldn't tell which branch new Threads start from.")
    if (behind.commits === 0) return { kind: "current", from: behind.from }
    try {
      await git(path, ["merge", "--no-edit", "-m", `Merge ${behind.from} into ${worktree.branch}`, behind.commit])
      return { kind: "updated", from: behind.from, commits: behind.commits }
    } catch (error) {
      const conflicted = (await git(path, ["diff", "--name-only", "--diff-filter=U", "-z"]).catch(() => "")).split("\0").filter(Boolean)
      if (conflicted.length) return { kind: "conflicts", from: behind.from, files: conflicted }
      await git(path, ["merge", "--abort"]).catch(() => undefined)
      throw new Error(`Git couldn't merge ${behind.from}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  private async mergeCheck(worktree: ThreadWorktree, into: string | null, commits: number, dirty: boolean): Promise<WorktreeMergeCheck> {
    if (!into) return { ok: false, reason: "The main checkout isn't on a branch." }
    if (dirty) return { ok: false, reason: "Commit or discard this worktree's changes first." }
    if (commits === 0) return { ok: false, reason: `Nothing is committed here that ${into} doesn't have.` }
    const main = await git(worktree.repoRoot, ["status", "--porcelain", "--untracked-files=no"]).catch(() => "unreadable")
    if (main) return { ok: false, reason: `The main checkout has uncommitted changes on ${into}.` }
    const busy = await this.working(worktree.repoRoot)
    if (busy.length) return { ok: false, reason: `${busy.join(", ")} ${busy.length === 1 ? "is" : "are"} working in the main checkout. Merge once ${busy.length === 1 ? "it stops" : "they stop"}.` }
    // Merged in memory first: a conflict is found without touching either checkout. Older Git
    // can't, and then the merge itself finds it and is aborted.
    if (await mergesWithoutCheckout() && !await succeeds(worktree.repoRoot, ["merge-tree", "--write-tree", into, worktree.branch]))
      return { ok: false, reason: `It conflicts with ${into}. Update it from ${into} and resolve the conflict here, or open a pull request.` }
    return { ok: true, into }
  }

  /** The review's files, before and after, for the diff viewer. */
  async reviewDiffs(path: string): Promise<{ diffs: GitDiff[]; truncated: number }> {
    const review = await this.review(path)
    const diffs: GitDiff[] = []
    let bytes = 0
    for (const file of review.files) {
      if (diffs.length >= REVIEW_FILES || bytes >= REVIEW_BYTES) break
      if (file.insertions === null) {
        diffs.push({ path: file.path, binary: true, oldFile: null, newFile: null })
        continue
      }
      const [before, after] = await Promise.all([
        shown(path, review.base, file.from ?? file.path),
        readFile(join(path, file.path), "utf8").catch(() => null),
      ])
      if ((before?.length ?? 0) > REVIEW_FILE_BYTES || (after?.length ?? 0) > REVIEW_FILE_BYTES) {
        diffs.push({ path: file.path, binary: false, oldFile: null, newFile: null, preview: { kind: "unavailable", reason: "Too large to show here." } })
        continue
      }
      bytes += (before?.length ?? 0) + (after?.length ?? 0)
      diffs.push({
        path: file.path,
        binary: false,
        oldFile: before === null ? null : { name: file.from ?? file.path, contents: before },
        newFile: after === null ? null : { name: file.path, contents: after },
      })
    }
    return { diffs, truncated: review.files.length - diffs.length }
  }

  /**
   * Merge the worktree's branch into the branch the main checkout has out,
   * only when the review says it is safe; a merge Git stops is aborted, so
   * the main checkout is left as it was.
   */
  async merge(path: string): Promise<{ branch: string; into: string }> {
    const review = await this.review(path)
    if (!review.merge.ok) throw new Error(review.merge.reason)
    const { repoRoot } = this.known(path)
    try {
      await git(repoRoot, ["merge", "--no-edit", review.branch])
    } catch (error) {
      await git(repoRoot, ["merge", "--abort"]).catch(() => undefined)
      throw new Error(`Git stopped the merge and ${review.merge.into} was left as it was. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    return { branch: review.branch, into: review.merge.into }
  }

  /** What the recipe's install steps' outputs did for a conversation's worktree, once it finishes. */
  outputs(conversationId: string): Promise<OutputsCarry> | undefined {
    return this.carrying.get(conversationId)
  }

  /** Record a started conversation's worktree against the Thread its journal joined. */
  async attach(conversationId: string): Promise<void> {
    const receipt = await this.receipt(conversationId)
    const placed = this.threads.journalPlacement(conversationId)
    if (receipt?.state !== "ready" || !placed) return
    this.threads.attachWorktree({
      path: receipt.path,
      thread: placed.thread,
      repoRoot: receipt.repoRoot,
      project: receipt.source,
      branch: receipt.branch,
      base: receipt.base,
    })
  }

  /**
   * This device's worktrees. One deleted outside Mako is forgotten here, and
   * a receipt whose start finished before the host stopped is attached.
   */
  async list(): Promise<ThreadWorktreeList> {
    const known = new Set(this.threads.worktrees().map((worktree) => worktree.path))
    const receipts = await readdir(this.receipts()).catch(() => [])
    const made = new Map<string, Receipt>()
    for (const file of receipts) {
      const id = file.endsWith(".json") ? file.slice(0, -5) : ""
      if (!z.string().uuid().safeParse(id).success) continue
      const receipt = await this.receipt(id).catch(() => undefined)
      if (receipt?.state === "ready") made.set(receipt.path, receipt)
      if (receipt && !known.has(receipt.path) && existsSync(receipt.path)) await this.attach(id)
    }
    const worktrees: ThreadWorktree[] = []
    for (const worktree of this.threads.worktrees()) {
      if (!existsSync(worktree.path)) {
        this.threads.detachWorktree(worktree.path)
        continue
      }
      const receipt = made.get(worktree.path)
      worktrees.push(receipt ? {
        ...worktree,
        start: { from: receipt.from ?? null, adopted: receipt.adopted ?? false, tookMs: receipt.tookMs ?? 0, copied: receipt.copied ?? 0, spare: receipt.spare ?? false },
      } : worktree)
    }
    return { root: this.root, worktrees }
  }

  /**
   * Remove a worktree that nothing runs in and nothing is uncommitted in.
   * Its branch stays, so committed work is never lost. The folder is moved
   * aside at once and deleted in the background, so tens of thousands of
   * installed files don't hold the answer up.
   */
  async remove(path: string): Promise<ThreadWorktreeList> {
    const attached = this.threads.worktrees().find((candidate) => candidate.path === path)
    const receipts = (await this.receiptsList()).filter(({ receipt }) => receipt.path === path)
    const repoRoot = attached?.repoRoot ?? receipts[0]?.receipt.repoRoot
    if (!repoRoot) throw new Error("Mako didn't make this worktree, so it won't remove it.")
    const users = await this.inUse(path)
    if (users.length)
      throw new Error(`${basename(path)} is in use by ${users.join(", ")}. Stop ${users.length === 1 ? "it" : "them"}, then remove the worktree.`)
    if (existsSync(path)) {
      const blocker = await removalBlocker(path)
      if (blocker) throw new Error(blocker)
      if (attached) {
        await this.environment?.stop(attached.thread)
        await this.environment?.cleanup?.(attached.thread, path)
      }
      await setAside(repoRoot, path, this.trash())
    } else {
      if (attached) await this.environment?.stop(attached.thread)
      await git(repoRoot, ["worktree", "prune"]).catch(() => {})
    }
    if (attached) {
      this.threads.detachWorktree(path)
      await this.environment?.discard(attached.thread, path)
    }
    for (const { id } of receipts) await rm(join(this.receipts(), `${id}.json`), { force: true })
    return this.list()
  }

  /**
   * Move the uncommitted work of the checkout this conversation's worktree
   * was made from into the worktree, which starts at the same commit:
   * staged, unstaged and untracked files, through one stash. When the
   * worktree can't take it, the stash stays, named, so nothing is lost.
   */
  async moveChanges(conversationId: string): Promise<number> {
    const receipt = await this.receipt(conversationId)
    if (receipt?.state !== "ready") throw new Error("This conversation has no worktree to move changes into.")
    const kept = (stash: string, cause?: unknown) => new Error(`The worktree couldn't take the changes, so they're kept in the main checkout's stash as "${stash}".`, { cause })
    if (receipt.moved) {
      if ("stash" in receipt.moved) throw kept(receipt.moved.stash)
      return receipt.moved.files
    }
    const { repoRoot, path, branch } = receipt
    const message = `Mako: moving to ${branch}`
    const stashes = async () => (await git(repoRoot, ["stash", "list", "--format=%H%x09%gs"])).split("\n").filter(Boolean).map((line) => line.split("\t"))
    // A move cut short after the stash was made finds it again by its name.
    let stash = receipt.moving ? (await stashes()).find(([, subject]) => subject?.endsWith(`: ${message}`))?.[0] : undefined
    let changed = receipt.moving?.files ?? 0
    if (stash && await git(path, ["status", "--porcelain", "--untracked-files=all"]).then(Boolean, () => false)) {
      // Applied before it was cut short: the worktree already has the changes.
    } else {
      if (!stash) {
        changed = (await git(repoRoot, ["status", "--porcelain", "--untracked-files=all"])).split("\n").filter(Boolean).length
        if (!changed) {
          await this.save({ ...receipt, moving: undefined, moved: { files: 0 } })
          return 0
        }
        const [head, base] = await Promise.all([git(repoRoot, ["rev-parse", "HEAD"]), git(path, ["rev-parse", "HEAD"])])
        if (head !== base) throw new Error("The main checkout moved to another commit while the worktree was made, so its changes stayed where they are.")
        await this.save({ ...receipt, moving: { stash: message, files: changed } })
        await git(repoRoot, ["stash", "push", "--include-untracked", "--message", message])
        stash = await git(repoRoot, ["rev-parse", "--verify", "refs/stash"])
      }
      const applying = stash
      try {
        // `--index` keeps what was staged staged; Git refuses it before touching anything when it can't.
        await git(path, ["stash", "apply", "--index", applying]).catch(() => git(path, ["stash", "apply", applying]))
      } catch (error) {
        await this.save({ ...receipt, moving: undefined, moved: { stash: message } })
        throw kept(message, error)
      }
    }
    await this.save({ ...receipt, moving: undefined, moved: { files: changed } })
    const index = (await stashes()).findIndex(([hash]) => hash === stash)
    if (index >= 0) await git(repoRoot, ["stash", "drop", "--quiet", `stash@{${index}}`])
    return changed
  }

  /**
   * Take back a worktree made for a conversation that didn't start: its
   * folder, its receipt, and its still-empty branch. A folder that isn't
   * exactly as the start left it (another branch, or anything a removal would
   * lose) stays, listed in Settings as in no Thread.
   */
  async abandon(conversationId: string): Promise<void> {
    const receipt = await this.receipt(conversationId)
    if (!receipt) return
    if (existsSync(receipt.path)) {
      const on = await git(receipt.path, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "")
      if (on !== receipt.branch || (await this.inUse(receipt.path)).length || await removalBlocker(receipt.path)) return
      await setAside(receipt.repoRoot, receipt.path, this.trash())
    }
    const commits = receipt.adopted ? 1 : await git(receipt.repoRoot, ["rev-list", "--count", `${receipt.base}..${receipt.branch}`]).then(Number, () => 1)
    if (commits === 0) await git(receipt.repoRoot, ["branch", "-D", receipt.branch]).catch(() => undefined)
    await rm(join(this.receipts(), `${conversationId}.json`), { force: true })
  }

  private projectFolder(repoRoot: string): string {
    const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8)
    return join(this.root, `${basename(repoRoot)}-${hash}`)
  }

  private receipts(): string {
    return join(this.root, "receipts")
  }

  private trash(): string {
    return join(this.root, "trash")
  }

  private async receiptsList(): Promise<{ id: string; receipt: Receipt; createdAt: number }[]> {
    const found: { id: string; receipt: Receipt; createdAt: number }[] = []
    for (const file of await readdir(this.receipts()).catch(() => [])) {
      const id = file.endsWith(".json") ? file.slice(0, -5) : ""
      const receipt = await this.receipt(id).catch(() => undefined)
      if (!receipt) continue
      const createdAt = await stat(join(this.receipts(), file)).then(({ birthtimeMs, mtimeMs }) => Math.round(birthtimeMs || mtimeMs), () => Date.now())
      found.push({ id, receipt, createdAt })
    }
    return found
  }

  private async receipt(conversationId: string): Promise<Receipt | undefined> {
    if (!z.string().uuid().safeParse(conversationId).success) return undefined
    const text = await readFile(join(this.receipts(), `${conversationId}.json`), "utf8").catch(() => null)
    return text === null ? undefined : ReceiptSchema.parse(JSON.parse(text))
  }

  private async save(receipt: Receipt): Promise<void> {
    await mkdir(this.receipts(), { recursive: true, mode: 0o700 })
    const target = join(this.receipts(), `${receipt.conversation}.json`)
    const pending = `${target}.${randomUUID()}.tmp`
    await writeFile(pending, JSON.stringify(receipt), { mode: 0o600 })
    await rename(pending, target)
  }

  private async create(conversationId: string, cwd: string, name: string | undefined, from: WorktreeFrom, onStep?: (step: WorktreeStep) => void): Promise<Receipt> {
    const began = performance.now()
    const source = await realpath(cwd)
    let receipt = await this.receipt(conversationId)
    if (receipt && receipt.source !== source) throw new Error("This conversation's worktree was made from another folder")
    if (receipt?.state === "ready" && existsSync(receipt.path)) return receipt
    if (!receipt) {
      let repoRoot: string
      let base: string
      try {
        ;[repoRoot = "", base = ""] = (await git(source, ["rev-parse", "--show-toplevel", "--verify", "HEAD^{commit}"])).split("\n")
      } catch (error) {
        if (error instanceof GitError && /not a git repository/i.test(error.stderr))
          throw new Error(`${basename(source)} isn't in a Git repository, so it can't have a worktree. Choose Project folder to work in the folder itself.`, { cause: error })
        throw new Error("This repository has no commits yet, so a worktree has nothing to start from. Make a first commit, or choose Project folder.", { cause: error })
      }
      let adopted: string | undefined
      let started: string | undefined
      if (from.kind === "newest") ({ commit: base, from: started } = await this.starts.point(repoRoot, false))
      else if (from.kind === "from") {
        base = await git(repoRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${from.ref}^{commit}`]).catch(() => "")
        if (!base) throw new Error(`${from.ref} isn't in ${basename(repoRoot)} anymore. Choose another branch to start from.`)
        started = from.ref
      } else if (from.kind === "head") started = await git(source, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => base.slice(0, 7))
      else ({ branch: adopted, base } = await this.adopt(repoRoot, from))
      const parent = this.projectFolder(repoRoot)
      const slug = adopted
        ? this.freeFolder(parent, worktreeSlug(adopted.replace(/[/_.]+/g, " ")))
        : await this.reserveSlug(repoRoot, parent, worktreeSlug(name), base)
      const path = join(parent, slug)
      const inside = relative(repoRoot, source)
      receipt = {
        conversation: conversationId,
        source,
        repoRoot,
        path,
        cwd: inside && !inside.startsWith("..") ? join(path, inside) : path,
        branch: adopted ?? `${BRANCH_PREFIX}${slug}`,
        base,
        state: "creating",
      }
      if (adopted) receipt.adopted = true
      if (started) receipt.from = started
      await this.save(receipt)
    }
    onStep?.("checkout")
    let spare: Spare | undefined
    // A receipt from before names were held by their branch may not have one yet.
    if (!(await succeeds(receipt.repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${receipt.branch}`])))
      await git(receipt.repoRoot, ["branch", "--no-track", receipt.branch, receipt.base])
    // `.git` rather than asking Git, which would answer for a repository around an empty folder.
    const existed = existsSync(join(receipt.path, ".git"))
    if (!existed) {
      spare = await this.fromSpare(receipt)
      if (!spare) {
        await mkdir(dirname(receipt.path), { recursive: true, mode: 0o700 })
        try {
          await git(receipt.repoRoot, [...PARALLEL_CHECKOUT, "worktree", "add", receipt.path, receipt.branch])
        } catch (error) {
          if (error instanceof GitError && /already (checked out|used by worktree)/i.test(error.stderr))
            throw new Error(`${receipt.branch} is checked out in another folder. Git keeps a branch in one checkout at a time, so start a new branch from it instead.`, { cause: error })
          throw new Error(`Git couldn't create the worktree: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
        }
      }
    }
    // A start cut short between placing a spare and checking out its branch finishes here.
    if (existed && !(await succeeds(receipt.path, ["symbolic-ref", "-q", "HEAD"])))
      await git(receipt.path, ["checkout", "-q", receipt.branch])
    const recipe = await this.setup?.recipe(receipt.path).catch(() => undefined)
    if (recipe?.carry?.length) onStep?.("carry")
    const copied = await carryFiles(receipt.repoRoot, receipt.path, recipe?.carry ?? [])
    const ready: Receipt = { ...receipt, state: "ready", copied, tookMs: Math.round(performance.now() - began) }
    if (spare) ready.spare = true
    await this.save(ready)
    this.carryOutputs(conversationId, ready.repoRoot, ready.path, recipe?.prepare ?? [])
    const wanted = this.spares.want(ready.repoRoot).catch(() => {})
    this.wanting.add(wanted)
    void wanted.finally(() => this.wanting.delete(wanted))
    return ready
  }

  /** A spare placed at the receipt's path and branched, or none; a spare that fails is given back and the send checks out fresh. */
  private async fromSpare(receipt: Receipt): Promise<Spare | undefined> {
    const spare = await this.spares.claim(receipt.repoRoot)
    if (!spare) return undefined
    try {
      await this.spares.place(spare, receipt.path, receipt.branch, receipt.base)
    } catch {
      await this.spares.discard(spare)
      if (!existsSync(receipt.path)) return undefined
      // Moved but not on its branch: check it out here rather than leave it detached.
      if (!(await succeeds(receipt.path, ["symbolic-ref", "-q", "HEAD"]))) await git(receipt.path, ["checkout", "-q", receipt.branch])
    }
    await this.spares.used(spare)
    // A warmed spare must obey the current recipe as well as the current inputs.
    const recipe = await this.setup?.recipe(receipt.path)
    for (const outputs of spare.outputs) {
      const [main, here] = await Promise.all([inputsDigest(receipt.repoRoot, outputs.inputs), inputsDigest(receipt.path, outputs.inputs)])
      const step = recipe?.prepare.find((step) => step.command === outputs.command &&
        step.inputs.length === outputs.inputs.length && step.inputs.every((input, index) => input === outputs.inputs[index]))
      let removed = false
      for (const entry of outputs.entries) {
        if (main === outputs.digest && here === outputs.digest &&
          step?.outputs?.some((pattern) => matchesGlob(entry, pattern))) continue
        const aside = join(this.trash(), randomUUID())
        await mkdir(this.trash(), { recursive: true, mode: 0o700 })
        if (await rename(join(receipt.path, entry), aside).then(() => true, () => false)) void removeBelowAgents(aside)
        removed = true
      }
      // The record came with the spare; a step whose outputs went runs again.
      const record = removed ? await this.setup?.prepared(receipt.path) : undefined
      if (record && record.done[outputs.command] !== undefined) {
        const done = Object.fromEntries(Object.entries(record.done).filter(([command]) => command !== outputs.command))
        await this.setup!.savePrepared(receipt.path, { ...record, done })
      }
    }
    return spare
  }

  private carryOutputs(conversationId: string, repoRoot: string, path: string, steps: PrepareStep[]): void {
    const work = carryOutputs(repoRoot, path, steps, this.setup).catch((error): OutputsCarry => ({
      carried: [],
      skipped: [error instanceof Error ? error.message : String(error)],
    }))
    this.carrying.set(conversationId, work)
    for (const key of this.carrying.keys()) {
      if (this.carrying.size <= MAX_REMEMBERED_CARRIES) break
      this.carrying.delete(key)
    }
  }

  /**
   * The local branch a Thread working on an existing branch or pull request
   * checks out, made to track the remote's when only the remote has it, and
   * its commit. Refused while another checkout has it.
   */
  private async adopt(repoRoot: string, start: Exclude<WorktreeStart, { kind: "from" }>): Promise<{ branch: string; base: string }> {
    const has = (branch: string) => succeeds(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])
    // A pull request is on the remote the project folder's branch pulls from.
    const pullRemote = async () =>
      (await this.starts.tracked(repoRoot, await git(repoRoot, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "")))?.remote ?? "origin"
    let branch: string
    if (start.kind === "pull" && start.cross) {
      branch = `pr-${start.number}`
      if (!(await has(branch))) {
        const remote = await pullRemote()
        try {
          await fetchQuietly(repoRoot, [remote, `refs/pull/${start.number}/head:refs/heads/${branch}`])
        } catch (error) {
          throw new Error(`Couldn't fetch #${start.number} from ${remote}. Check your connection, then try again.`, { cause: error })
        }
      }
    } else if (start.kind === "pull") {
      branch = start.branch
      if (!(await has(branch))) {
        const remote = await pullRemote()
        try {
          await fetchQuietly(repoRoot, [remote, `refs/heads/${branch}:refs/remotes/${remote}/${branch}`])
        } catch (error) {
          throw new Error(`Couldn't fetch ${branch} for #${start.number} from ${remote}. Check your connection, then try again.`, { cause: error })
        }
        await git(repoRoot, ["branch", "--track", branch, `${remote}/${branch}`])
      }
    } else if (await has(start.branch)) branch = start.branch
    else {
      const remote = (await git(repoRoot, ["remote"])).split("\n").find((candidate) => candidate && start.branch.startsWith(`${candidate}/`))
      if (!remote || !(await succeeds(repoRoot, ["show-ref", "--verify", "--quiet", `refs/remotes/${start.branch}`])))
        throw new Error(`${start.branch} isn't in ${basename(repoRoot)} anymore. Choose another branch.`)
      branch = start.branch.slice(remote.length + 1)
      if (!(await has(branch))) await git(repoRoot, ["branch", "--track", branch, start.branch])
    }
    const holder = await git(repoRoot, ["for-each-ref", "--format=%(worktreepath)", `refs/heads/${branch}`]).catch(() => "")
    if (holder)
      throw new Error(`${branch} is checked out in ${holder === repoRoot ? "your project folder" : basename(holder)}. Git keeps a branch in one checkout at a time, so start a new branch from it instead.`)
    return { branch, base: await git(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]) }
  }

  /** A folder name under `parent` nothing has yet, for a worktree on a branch that already has its name. */
  private freeFolder(parent: string, slug: string): string {
    for (let index = 1; index <= 50; index += 1) {
      const candidate = index === 1 ? slug : `${slug}-${index}`
      if (!existsSync(join(parent, candidate))) return candidate
    }
    return `${slug}-${randomUUID().slice(0, 6)}`
  }

  /**
   * A name no other worktree has, held by creating its branch at `base`. Git
   * creates a branch only when it doesn't exist, so two starts, in this host
   * or another sharing the folder, never get the same name and folder.
   */
  private async reserveSlug(repoRoot: string, parent: string, slug: string, base: string): Promise<string> {
    const taken = new Set((await git(repoRoot, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${BRANCH_PREFIX}`])).split("\n").filter(Boolean))
    const candidates = Array.from({ length: 50 }, (_, index) => index === 0 ? slug : `${slug}-${index + 1}`)
    candidates.push(`${slug}-${randomUUID().slice(0, 6)}`)
    for (const candidate of candidates) {
      if (taken.has(`${BRANCH_PREFIX}${candidate}`) || existsSync(join(parent, candidate))) continue
      try {
        await git(repoRoot, ["branch", "--no-track", `${BRANCH_PREFIX}${candidate}`, base])
        return candidate
      } catch (error) {
        if (!(error instanceof GitError && /already exists/i.test(error.stderr))) throw error
      }
    }
    throw new Error(`Every name for this worktree is taken in ${basename(repoRoot)}. Remove some mako/ branches, then try again.`)
  }
}
