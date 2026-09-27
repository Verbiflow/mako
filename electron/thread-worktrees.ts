import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants, existsSync } from "node:fs"
import { copyFile, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { availableParallelism } from "node:os"
import { basename, dirname, join, relative } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import type { ThreadStore } from "./thread-store.js"
import type { ThreadWorktree, ThreadWorktrees as ThreadWorktreeList } from "./contracts/thread-worktrees.js"

const execute = promisify(execFile)
const BRANCH_PREFIX = "mako/"
/**
 * Gitignored files a worktree gets from the main checkout. Mako's own list,
 * not another tool's file: a project's setup recipe will extend it.
 */
const CARRIED = [".env", ".env.*"]
const SLUG_WORDS = 4
const SLUG_LENGTH = 32
const FILLER = new Set(["a", "an", "the", "to", "of", "and", "in", "on", "for", "with", "please", "can", "could",
  "you", "i", "me", "my", "we", "our", "this", "that", "it", "is", "be", "let", "lets", "let's"])

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
}

const GitFailureSchema = z.object({ stderr: z.string() })

class GitError extends Error {
  readonly stderr: string
  constructor(stderr: string, cause: unknown) {
    super(stderr.trim() || "git failed", { cause })
    this.name = "GitError"
    this.stderr = stderr.trim()
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execute("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 16 * 1024 * 1024,
    })
    return stdout.trim()
  } catch (error) {
    throw new GitError(GitFailureSchema.safeParse(error).data?.stderr ?? "", error)
  }
}

function succeeds(cwd: string, args: string[]): Promise<boolean> {
  return git(cwd, args).then(() => true, () => false)
}

/** A branch-safe name from the Thread's first words: "Fix the login redirect" becomes `fix-login-redirect`. */
export function worktreeSlug(text: string | undefined): string {
  const words = (text ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((word) => word && !FILLER.has(word))
    .slice(0, SLUG_WORDS)
  return words.join("-").slice(0, SLUG_LENGTH).replace(/-+$/, "") || "thread"
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
 * Git's parallel checkout. APFS spends extra workers on contention past four;
 * Linux filesystems keep gaining to about eight (50,000 files: one worker
 * 10-20 s, these 2-5 s, for about the same CPU).
 */
const CHECKOUT_WORKERS = Math.min(process.platform === "darwin" ? 4 : 8, availableParallelism())

/**
 * The main checkout's gitignored inputs a fresh checkout lacks. Entries the
 * worktree already has are left alone, so a retry never overwrites what the
 * Thread's agent wrote.
 */
async function carryIgnored(repoRoot: string, destination: string): Promise<number> {
  const include = CARRIED.map((pattern) => `--exclude=${pattern}`)
  const listed = (await git(repoRoot, ["ls-files", "--others", "--ignored", "--directory", "-z", ...include]))
    .split("\0")
    .map((entry) => entry.replace(/\/+$/, ""))
    .filter((entry) => entry && entry !== ".git" && !entry.startsWith(".git/"))
  let copied = 0
  for (const entry of listed) {
    const from = join(repoRoot, entry)
    const to = join(destination, entry)
    if (existsSync(to)) continue
    await mkdir(dirname(to), { recursive: true })
    const info = await lstat(from)
    if (info.isSymbolicLink()) await symlink(await readlink(from), to)
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
 */
export class ThreadWorktreeService {
  readonly root: string
  private readonly threads: ThreadStore
  private readonly inUse: (path: string) => Promise<string[]>
  private readonly pending = new Map<string, Promise<Receipt>>()

  /** `inUse` names what runs inside a folder: conversations and shells. */
  constructor(root: string, threads: ThreadStore, inUse: (path: string) => Promise<string[]> = async () => []) {
    this.root = root
    this.threads = threads
    this.inUse = inUse
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
    }))
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
   * Its branch stays, so committed work is never lost; git refuses a
   * worktree with changes, and so does this.
   */
  async remove(path: string): Promise<ThreadWorktreeList> {
    const worktree = this.threads.worktrees().find((candidate) => candidate.path === path)
    if (!worktree) throw new Error("Mako didn't make this worktree, so it won't remove it.")
    const users = await this.inUse(path)
    if (users.length)
      throw new Error(`${basename(path)} is in use by ${users.join(", ")}. Stop ${users.length === 1 ? "it" : "them"}, then remove the worktree.`)
    if (existsSync(path)) {
      try {
        await git(worktree.repoRoot, ["worktree", "remove", path])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/modified or untracked|contains/i.test(message))
          throw new Error(`${basename(path)} has changes that aren't committed. Commit or discard them, then remove the worktree.`, { cause: error })
        throw new Error(`Git couldn't remove the worktree: ${message}`, { cause: error })
      }
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

  private receipts(): string {
    return join(this.root, "receipts")
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
        repoRoot = await git(source, ["rev-parse", "--show-toplevel"])
      } catch (error) {
        throw new Error(`${basename(source)} isn't in a Git repository, so it can't have a worktree. Switch to Local to start in the folder itself.`, { cause: error })
      }
      try {
        base = await git(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
      } catch (error) {
        throw new Error("This repository has no commits yet, so a worktree has nothing to start from. Make a first commit, or switch to Local.", { cause: error })
      }
      const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8)
      const parent = join(this.root, `${basename(repoRoot)}-${hash}`)
      const slug = await this.freeSlug(repoRoot, parent, worktreeSlug(name))
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
    if (!existsSync(receipt.path) || !(await succeeds(receipt.path, ["rev-parse", "--git-dir"]))) {
      const branched = await succeeds(receipt.repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${receipt.branch}`])
      await mkdir(dirname(receipt.path), { recursive: true, mode: 0o700 })
      try {
        const parallel = ["-c", `checkout.workers=${CHECKOUT_WORKERS}`, "-c", "checkout.thresholdForParallelism=100"]
        await git(receipt.repoRoot, branched
          ? [...parallel, "worktree", "add", receipt.path, receipt.branch]
          : [...parallel, "worktree", "add", "-b", receipt.branch, receipt.path, receipt.base])
      } catch (error) {
        throw new Error(`Git couldn't create the worktree: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
    }
    const copied = await carryIgnored(receipt.repoRoot, receipt.path)
    const ready: Receipt = { ...receipt, state: "ready", copied, tookMs: Math.round(performance.now() - began) }
    await this.save(ready)
    return ready
  }

  private async freeSlug(repoRoot: string, parent: string, slug: string): Promise<string> {
    for (let n = 1; n <= 50; n += 1) {
      const candidate = n === 1 ? slug : `${slug}-${n}`
      if (existsSync(join(parent, candidate))) continue
      if (await succeeds(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${BRANCH_PREFIX}${candidate}`])) continue
      return candidate
    }
    return `${slug}-${randomUUID().slice(0, 6)}`
  }
}