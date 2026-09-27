import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants, existsSync } from "node:fs"
import { copyFile, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import type { ThreadStore } from "./thread-store.js"
import { WORKTREE_BRANCH_PREFIX as BRANCH_PREFIX, worktreeSlug } from "./contracts/thread-worktrees.js"
import type { ThreadWorktree, ThreadWorktrees as ThreadWorktreeList } from "./contracts/thread-worktrees.js"
import { carryDependencies, ignoredEntries, lockDigest, removeBelowAgents, type DependencyCarry } from "./worktree-dependencies.js"
import { git, GitError, PARALLEL_CHECKOUT, succeeds } from "./worktree-git.js"
import { placeSpare, setAside, WorktreeSpares, type Spare } from "./worktree-spares.js"

const execute = promisify(execFile)
/**
 * Gitignored files a worktree gets from the main checkout. Mako's own list,
 * not another tool's file: a project's setup recipe will extend it.
 */
const CARRIED = /^\.env(\..+)?$/
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
    if (info.isSymbolicLink()) await symlink(await readlink(from), to)
    else if (info.isFile() && info.size < CLONE_FROM_BYTES) await copyFile(from, to, constants.COPYFILE_EXCL)
    else await cloneEntry(from, to, info.isDirectory())
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
export class ThreadWorktreeService {
  readonly root: string
  private readonly threads: ThreadStore
  private readonly inUse: (path: string) => Promise<string[]>
  private readonly pending = new Map<string, Promise<Receipt>>()
  private readonly carrying = new Map<string, Promise<DependencyCarry>>()
  private readonly wanting = new Set<Promise<void>>()
  private readonly spares: WorktreeSpares

  /** `inUse` names what runs inside a folder: conversations and shells. */
  constructor(root: string, threads: ThreadStore, inUse: (path: string) => Promise<string[]> = async () => []) {
    this.root = root
    this.threads = threads
    this.inUse = inUse
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

  /** Commits on a worktree's branch since the commit it started at; undefined for a folder that isn't one of Mako's worktrees. */
  async ahead(path: string): Promise<number | undefined> {
    const worktree = this.threads.worktrees().find((entry) => entry.path === path)
    if (!worktree || !existsSync(path)) return undefined
    return Number(await git(path, ["rev-list", "--count", `${worktree.base}..HEAD`]))
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
    const worktree = this.threads.worktrees().find((candidate) => candidate.path === path)
    if (!worktree) throw new Error("Mako didn't make this worktree, so it won't remove it.")
    const users = await this.inUse(path)
    if (users.length)
      throw new Error(`${basename(path)} is in use by ${users.join(", ")}. Stop ${users.length === 1 ? "it" : "them"}, then remove the worktree.`)
    if (existsSync(path)) {
      let changes: string
      try {
        changes = await git(path, ["status", "--porcelain", "--untracked-files=normal"])
      } catch (error) {
        throw new Error(`Git couldn't read the worktree: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
      if (changes) throw new Error(`${basename(path)} has changes that aren't committed. Commit or discard them, then remove the worktree.`)
      await setAside(worktree.repoRoot, path, this.trash())
    } else {
      await git(worktree.repoRoot, ["worktree", "prune"]).catch(() => {})
    }
    this.threads.detachWorktree(path)
    for (const file of await readdir(this.receipts()).catch(() => [])) {
      const receipt = file.endsWith(".json") ? await this.receipt(file.slice(0, -5)) : undefined
      if (receipt?.path === path) await rm(join(this.receipts(), file), { force: true })
    }
    return this.list()
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
    const branches = async (repoRoot: string) =>
      new Set((await git(repoRoot, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${BRANCH_PREFIX}`])).split("\n").filter(Boolean))
    let taken: Set<string> | undefined
    if (!receipt) {
      let repoRoot: string
      let base: string
      try {
        ;[repoRoot = "", base = ""] = (await git(source, ["rev-parse", "--show-toplevel", "--verify", "HEAD^{commit}"])).split("\n")
      } catch (error) {
        if (error instanceof GitError && /not a git repository/i.test(error.stderr))
          throw new Error(`${basename(source)} isn't in a Git repository, so it can't have a worktree. Switch to Local to start in the folder itself.`, { cause: error })
        throw new Error("This repository has no commits yet, so a worktree has nothing to start from. Make a first commit, or switch to Local.", { cause: error })
      }
      const parent = this.projectFolder(repoRoot)
      taken = await branches(repoRoot)
      const slug = this.freeSlug(taken, parent, worktreeSlug(name))
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
    const branched = (taken ?? await branches(receipt.repoRoot)).has(receipt.branch)
    const existed = existsSync(receipt.path) && await succeeds(receipt.path, ["rev-parse", "--git-dir"])
    if (!existed) {
      spare = branched ? undefined : await this.fromSpare(receipt)
      if (!spare) {
        await mkdir(dirname(receipt.path), { recursive: true, mode: 0o700 })
        try {
          await git(receipt.repoRoot, branched
            ? [...PARALLEL_CHECKOUT, "worktree", "add", receipt.path, receipt.branch]
            : [...PARALLEL_CHECKOUT, "worktree", "add", "-b", receipt.branch, receipt.path, receipt.base])
        } catch (error) {
          throw new Error(`Git couldn't create the worktree: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
        }
      }
    }
    // A start cut short between placing a spare and branching it finishes here.
    if (existed && !(await succeeds(receipt.path, ["symbolic-ref", "-q", "HEAD"])))
      await git(receipt.path, branched ? ["checkout", "-q", receipt.branch] : ["checkout", "-q", "-b", receipt.branch])
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
      // Moved but not branched: branch it here rather than leave it detached.
      if (!(await succeeds(receipt.path, ["symbolic-ref", "-q", "HEAD"]))) await git(receipt.path, ["checkout", "-q", "-b", receipt.branch])
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

  private freeSlug(branches: ReadonlySet<string>, parent: string, slug: string): string {
    for (let n = 1; n <= 50; n += 1) {
      const candidate = n === 1 ? slug : `${slug}-${n}`
      if (!existsSync(join(parent, candidate)) && !branches.has(`${BRANCH_PREFIX}${candidate}`)) return candidate
    }
    return `${slug}-${randomUUID().slice(0, 6)}`
  }
}
