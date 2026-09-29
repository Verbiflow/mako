import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants, existsSync } from "node:fs"
import { copyFile, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import type { ThreadStore } from "./thread-store.js"
import type { ThreadId } from "./contracts/thread-identity.js"
import { WORKTREE_BRANCH_PREFIX as BRANCH_PREFIX, worktreeSlug } from "./contracts/thread-worktrees.js"
import type { GitDiff } from "./contracts/git-workspace-search.js"
import type { ThreadWorktree, ThreadWorktrees as ThreadWorktreeList, WorktreeDetail, WorktreeInventory, WorktreeLanding, WorktreeMergeCheck, WorktreeReview, WorktreeReviewFile } from "./contracts/thread-worktrees.js"
import { carryDependencies, ignoredEntries, lockDigest, ownBytes, removeBelowAgents, type DependencyCarry } from "./worktree-dependencies.js"
import { git, GitError, gitExecutable, mergesWithoutCheckout, PARALLEL_CHECKOUT, succeeds } from "./worktree-git.js"
import { placeSpare, setAside, WorktreeSpares, type Spare } from "./worktree-spares.js"

const execute = promisify(execFile)
/**
 * Gitignored files a worktree gets from the main checkout. Mako's own list,
 * not another tool's file: a project's setup recipe will extend it.
 */
const CARRIED = /^\.env(\..+)?$/
/** Git's own markers for work under way, which a removal would throw away. */
const UNDER_WAY: readonly (readonly [string, string])[] = [
  ["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"], ["BISECT_LOG", "bisect"],
]
const CLONE_FROM_BYTES = 1024 * 1024
const MAX_REMEMBERED_CARRIES = 64

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
})
type Receipt = z.infer<typeof ReceiptSchema>

export interface PreparedWorktree {
  /** Where the conversation runs: the worktree, or the same subfolder in it the Thread was started from. */
  cwd: string
  path: string
  branch: string
  /** Gitignored entries carried over from the main checkout. */
  copied: number
  tookMs: number
  /** Taken from a checkout made ahead of time rather than checked out on the send. */
  spare: boolean
}

/**
 * Copy-on-write where the filesystem has it: APFS clones through `cp -c`, and
 * reflinks through FICLONE on btrfs and XFS. Both fall back to a plain copy
 * (another volume, HFS+, ext4). Node's FICLONE never clones on macOS: libuv
 * copies the bytes there.
 */
async function cloneEntry(from: string, to: string, directory: boolean): Promise<void> {
  if (process.platform === "darwin") await execute("/bin/cp", directory ? ["-c", "-n", "-R", from, to] : ["-c", "-n", from, to])
  else if (directory) await cp(from, to, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true })
  else await copyFile(from, to, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL)
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
 * The main checkout's gitignored inputs a fresh checkout lacks. Entries the
 * worktree already has are left alone, so a retry never overwrites what the
 * Thread's agent wrote. A small file is copied in-process; cloning only pays
 * for itself past the cost of starting `cp`.
 */
async function carryIgnored(repoRoot: string, destination: string): Promise<number> {
  const listed = (await ignoredEntries(repoRoot)).filter((entry) => CARRIED.test(basename(entry)))
  let copied = 0
  for (const entry of listed) {
    const from = join(repoRoot, entry)
    const to = join(destination, entry)
    if (existsSync(to)) continue
    await mkdir(dirname(to), { recursive: true })
    const info = await lstat(from)
    // A `.env` folder is a virtualenv: thousands of files whose scripts name the main checkout's path.
    if (info.isDirectory()) continue
    if (info.isSymbolicLink()) await symlink(await readlink(from), to)
    else if (info.isFile() && info.size < CLONE_FROM_BYTES) await copyFile(from, to, constants.COPYFILE_EXCL)
    else await cloneEntry(from, to, false)
    copied += 1
  }
  return copied
}

/**
 * Worktrees for Threads that start in one. Each is a branch `mako/{slug}`
 * checked out under `{root}/{repo}-{hash}/{slug}`, made on the Thread's
 * first send and never on a read. A receipt per conversation makes a
 * repeated start find the worktree the first attempt made, including one
 * cut short between `git worktree add` and the copy.
 *
 * The send takes a spare checkout when the project has one ready, and the
 * project's spares are topped up behind it (`WorktreeSpares`). Installed
 * dependencies follow in the background (`carryDependencies`).
 */
/** A Worktree Thread's running app ends with its worktree: its processes stop before the folder goes, and its data after. */
export interface ThreadEnvironmentEnd {
  stop(thread: ThreadId): Promise<void>
  discard(thread: ThreadId, path: string): Promise<void>
}

export class ThreadWorktreeService {
  readonly root: string
  private readonly threads: ThreadStore
  private readonly inUse: (path: string) => Promise<string[]>
  private readonly working: (path: string) => Promise<string[]>
  private readonly environment: ThreadEnvironmentEnd | undefined
  private readonly pending = new Map<string, Promise<Receipt>>()
  private readonly carrying = new Map<string, Promise<DependencyCarry>>()
  private readonly wanting = new Set<Promise<void>>()
  private readonly spares: WorktreeSpares

  /**
   * `inUse` names what is open inside a folder, conversations and shells;
   * `working`, the conversations there that are in the middle of a turn;
   * `environment`, what ends a Thread's running app with its worktree.
   */
  constructor(
    root: string,
    threads: ThreadStore,
    inUse: (path: string) => Promise<string[]> = async () => [],
    working: (path: string) => Promise<string[]> = async () => [],
    environment?: ThreadEnvironmentEnd,
  ) {
    this.root = root
    this.threads = threads
    this.inUse = inUse
    this.working = working
    this.environment = environment
    this.spares = new WorktreeSpares(root, (repoRoot) => this.projectFolder(repoRoot))
  }

  prepare(conversationId: string, cwd: string, name: string | undefined): Promise<PreparedWorktree> {
    z.string().uuid().parse(conversationId)
    let work = this.pending.get(conversationId)
    if (!work) {
      work = this.create(conversationId, cwd, name)
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
    return this.prepare(forkId, cwd, name)
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

  /** Resolves once spares being made and dependencies being cloned are in place. */
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
    const detailed = await mapLimited([...worktrees, ...loose.values()], 4, async (worktree): Promise<WorktreeDetail> => {
      const [status, landing, users, bytes] = await Promise.all([
        git(worktree.path, ["status", "--porcelain", "--untracked-files=normal"]).catch(() => null),
        this.landing(worktree),
        this.inUse(worktree.path),
        ownBytes(worktree.path),
      ])
      const held = await removalBlocker(worktree.path, status ?? undefined) ?? null
      return { ...worktree, changes: status ? status.split("\n").length : 0, held, landing, users, bytes }
    })
    const spares = await this.spares.recorded()
    const spareBytes = await mapLimited(spares, 4, (spare) => ownBytes(spare.path))
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
    const [commits, numstat, untracked, status] = await Promise.all([
      git(path, ["rev-list", "--count", `${base}..HEAD`]).then(Number),
      git(path, ["diff", "--numstat", "-z", "-M", base]),
      git(path, ["ls-files", "--others", "--exclude-standard", "-z"]),
      git(path, ["status", "--porcelain", "--untracked-files=normal"]),
    ])
    const files = parseNumstat(numstat)
    const added = untracked.split("\0").filter(Boolean)
    const counted = await mapLimited(added.slice(0, COUNTED_UNTRACKED), 8, (file) => textLines(join(path, file)))
    added.forEach((file, index) => {
      const lines = counted[index] ?? null
      files.push({ path: file, insertions: lines, deletions: lines === null ? null : 0 })
    })
    return { path, branch: worktree.branch, into, base, commits, files, merge: await this.mergeCheck(worktree, into, commits, status !== "") }
  }

  private async mergeCheck(worktree: ThreadWorktree, into: string | null, commits: number, dirty: boolean): Promise<WorktreeMergeCheck> {
    if (!into) return { ok: false, reason: "The project checkout isn't on a branch." }
    if (dirty) return { ok: false, reason: "Commit or discard this worktree's changes first." }
    if (commits === 0) return { ok: false, reason: `Nothing is committed here that ${into} doesn't have.` }
    const main = await git(worktree.repoRoot, ["status", "--porcelain", "--untracked-files=no"]).catch(() => "unreadable")
    if (main) return { ok: false, reason: `The project checkout has uncommitted changes on ${into}.` }
    const busy = await this.working(worktree.repoRoot)
    if (busy.length) return { ok: false, reason: `${busy.join(", ")} ${busy.length === 1 ? "is" : "are"} working in the project checkout. Merge once ${busy.length === 1 ? "it stops" : "they stop"}.` }
    // Merged in memory first: a conflict is found without touching either checkout. Older Git
    // can't, and then the merge itself finds it and is aborted.
    if (await mergesWithoutCheckout() && !await succeeds(worktree.repoRoot, ["merge-tree", "--write-tree", into, worktree.branch]))
      return { ok: false, reason: `It conflicts with ${into}. Merge ${into} into this branch and resolve it here, or open a pull request.` }
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

  /** The dependency clone for a conversation's worktree, once it finishes. */
  dependencies(conversationId: string): Promise<DependencyCarry> | undefined {
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
    for (const file of receipts) {
      const id = file.endsWith(".json") ? file.slice(0, -5) : ""
      if (!z.string().uuid().safeParse(id).success) continue
      const receipt = await this.receipt(id)
      if (receipt && !known.has(receipt.path) && existsSync(receipt.path)) await this.attach(id)
    }
    const worktrees: ThreadWorktree[] = []
    for (const worktree of this.threads.worktrees()) {
      if (existsSync(worktree.path)) worktrees.push(worktree)
      else this.threads.detachWorktree(worktree.path)
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
      if (attached) await this.environment?.stop(attached.thread)
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
    const kept = (stash: string, cause?: unknown) => new Error(`The worktree couldn't take the changes, so they're kept in the project checkout's stash as "${stash}".`, { cause })
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
        if (head !== base) throw new Error("The project checkout moved to another commit while the worktree was made, so its changes stayed where they are.")
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
    const commits = await git(receipt.repoRoot, ["rev-list", "--count", `${receipt.base}..${receipt.branch}`]).then(Number, () => 1)
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

  private async create(conversationId: string, cwd: string, name: string | undefined): Promise<Receipt> {
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
      const parent = this.projectFolder(repoRoot)
      const slug = await this.reserveSlug(repoRoot, parent, worktreeSlug(name), base)
      const path = join(parent, slug)
      const inside = relative(repoRoot, source)
      receipt = {
        conversation: conversationId,
        source,
        repoRoot,
        path,
        cwd: inside && !inside.startsWith("..") ? join(path, inside) : path,
        branch: `${BRANCH_PREFIX}${slug}`,
        base,
        state: "creating",
      }
      await this.save(receipt)
    }
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
          throw new Error(`Git couldn't create the worktree: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
        }
      }
    }
    // A start cut short between placing a spare and checking out its branch finishes here.
    if (existed && !(await succeeds(receipt.path, ["symbolic-ref", "-q", "HEAD"])))
      await git(receipt.path, ["checkout", "-q", receipt.branch])
    const copied = await carryIgnored(receipt.repoRoot, receipt.path)
    const ready: Receipt = { ...receipt, state: "ready", copied, tookMs: Math.round(performance.now() - began) }
    if (spare) ready.spare = true
    await this.save(ready)
    this.carryDependencies(conversationId, ready.repoRoot, ready.path)
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
      await placeSpare(spare, receipt.path, receipt.branch, receipt.base)
    } catch {
      await this.spares.discard(spare)
      if (!existsSync(receipt.path)) return undefined
      // Moved but not on its branch: check it out here rather than leave it detached.
      if (!(await succeeds(receipt.path, ["symbolic-ref", "-q", "HEAD"]))) await git(receipt.path, ["checkout", "-q", receipt.branch])
    }
    await this.spares.used(spare)
    // Its dependencies were cloned for the lockfiles of that moment; if either side's changed since, they go.
    if (spare.dependencies.length) {
      const [main, here] = await Promise.all([lockDigest(receipt.repoRoot), lockDigest(receipt.path)])
      if (main !== spare.lock || here !== spare.lock) {
        for (const entry of spare.dependencies) {
          const aside = join(this.trash(), randomUUID())
          await mkdir(this.trash(), { recursive: true, mode: 0o700 })
          if (await rename(join(receipt.path, entry), aside).then(() => true, () => false)) void removeBelowAgents(aside)
        }
      }
    }
    return spare
  }

  private carryDependencies(conversationId: string, repoRoot: string, path: string): void {
    const work = carryDependencies(repoRoot, path).catch((error): DependencyCarry => ({
      carried: [],
      skipped: error instanceof Error ? error.message : String(error),
    }))
    this.carrying.set(conversationId, work)
    for (const key of this.carrying.keys()) {
      if (this.carrying.size <= MAX_REMEMBERED_CARRIES) break
      this.carrying.delete(key)
    }
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
