import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Git, RunOptions } from "@mako/git"
import { MOVE_CHECKPOINT_MAX_BYTES, type MoveCheckpoint } from "@mako/protocol/moves"
import { contentRef, type Partition, type PartitionFile } from "../attribution/index.js"
import { commitIn, privateStore, writeCheckpoint } from "./move-checkpoint.js"
import { mapLimit, onDisk, sidesOf, type MoveLedger } from "./worktree-move.js"

/**
 * One Thread's changes in a checkout others work in too, as a checkpoint a cloud machine continues from: HEAD, with the
 * files the Thread last wrote at their Thread versions (the base plus its own lines, as a move to its worktree would
 * take them), on the Thread's own branch. The person's edits, another Thread's, and lines nobody can be named for are
 * never in it; the index commit is HEAD's tree, since what the person staged isn't the Thread's.
 *
 * Capture reads the checkout and writes nothing there: the Thread versions go into a scratch index over HEAD in a
 * private object store that borrows the repository's objects, and the bundle is `move-checkpoint.ts`'s, thinned
 * against `refs/remotes`. Its commits carry a fixed author and date, so the same changes make the same bundle, byte
 * for byte. Git runs below foreground work (`background`).
 *
 * What it leaves out it names: ignored files, what isn't a regular file (a symlink, a folder), a submodule, a Git LFS
 * file (its object may not be pushed), a file over `maxFileBytes`, the largest past `maxBytes` in all, and a file
 * whose Thread version can't be read from either side.
 */

/** The largest file a Thread's checkpoint takes. */
export const THREAD_CHECKPOINT_FILE_BYTES = 2 * 1024 * 1024

export type LeftOut = "ignored" | "not-a-file" | "submodule" | "lfs" | "too-large" | "over-total" | "unreadable"

export class ThreadCheckpointRefused extends Error {
  readonly kind: "no-commits" | "conflicts" | "in-progress" | "changing"
  constructor(kind: ThreadCheckpointRefused["kind"], message: string) {
    super(message)
    this.name = "ThreadCheckpointRefused"
    this.kind = kind
  }
}

export interface ThreadCheckpointInput {
  git: Git
  /**
   * The record of changes. `partition` may answer later: the host's reads it on a worker (`partitionOffLoop`), since
   * on a big journal it holds a thread for hundreds of milliseconds. `settled` is what a capture waits for; the host's
   * is the journal's `heard`, never its full settle, which waits on rescans.
   */
  ledger: Pick<MoveLedger, "settled" | "track" | "head"> & { partition(checkout: string, thread: string): Partition | Promise<Partition> }
  /** The partition the caller just read (`ledger.partition`), taken for the first try instead of reading it again. */
  partition?: Partition
  thread: string
  /** The repository's top folder: the checkout the Thread shares. */
  repoRoot: string
  /** The Thread's own branch, which the machine checks out at HEAD. */
  branch: string
  /** A directory the caller owns and removes: the bundle is written there. */
  folder: string
  /** Wait for the journal until then at most (`MoveHaste.by`). */
  by?: number
  maxFileBytes?: number
  /** The most the Thread's files may come to, before compression; the bundle keeps the move's own limit. */
  maxBytes?: number
}

export interface ThreadCheckpoint {
  checkpoint: MoveCheckpoint
  file: string
  /** Paths relative to the repository whose Thread version the checkpoint holds, deletions included. */
  took: string[]
  /**
   * Each of those files as the checkpoint has it, by its content address (`contentRef`), null for one it deleted: what
   * a Mac back from going away compares its checkout with before it takes the Thread's changes out of it.
   */
  versions: Array<{ path: string; ref: string | null }>
  /** What the Thread changed that the checkpoint leaves out, and why. */
  left: { path: string; why: LeftOut }[]
  /**
   * Commits on HEAD that no remote-tracking branch has: the bundle carries them to the machine, so whatever names the
   * checkpoint to the person says so ("includes 2 unpushed commits").
   */
  unpushed: number
  ms: number
}

const TIMEOUT_MS = 2 * 60_000
const PARALLEL = 8
const ATTEMPTS = 4
const GITLINK = 0o160000
/**
 * Every Git call here: no file-system monitor, and no split index, which would write its `sharedindex.*` beside the
 * person's index in their `.git` even for a scratch `GIT_INDEX_FILE`.
 */
const SCRATCH_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.splitIndex=false"]

async function out(git: Git, options: RunOptions): Promise<Buffer> {
  const result = await git.run({ timeoutMs: TIMEOUT_MS, background: true, ...options, args: [...SCRATCH_CONFIG, ...options.args] })
  if (result.truncated) throw new Error(`git ${options.args[0] ?? ""} wrote more than it may`)
  return result.stdout
}

const text = async (git: Git, options: RunOptions) => (await out(git, options)).toString("utf8").trim()
const nul = (paths: readonly string[]) => paths.map((path) => `${path}\0`).join("")
const split = (bytes: Buffer) => bytes.toString("utf8").split("\0").filter(Boolean)

/**
 * Each path's blob at HEAD, with its mode. Its bytes are as stored: where a filter or line endings make the file on
 * disk differ, a Thread version that is HEAD's whole file reads as neither side, and the file is left out and named.
 */
export async function atHead(git: Git, repoRoot: string, head: string, paths: readonly string[]): Promise<Map<string, { bytes: Buffer; mode: number }>> {
  const found = new Map<string, { bytes: Buffer; mode: number }>()
  if (!paths.length) return found
  const modes = new Map<string, number>()
  const listed: string[] = []
  for (let at = 0; at < paths.length; at += 500)
    listed.push(...split(await out(git, { cwd: repoRoot, args: ["ls-tree", "-z", "--full-tree", head, "--", ...paths.slice(at, at + 500)], read: true })))
  for (const entry of listed) {
    const tab = entry.indexOf("\t")
    modes.set(entry.slice(tab + 1), Number.parseInt(entry.slice(0, entry.indexOf(" ")), 8))
  }
  const blobs = paths.filter((path) => modes.has(path) && modes.get(path) !== GITLINK)
  if (!blobs.length) {
    for (const [path, mode] of modes) found.set(path, { bytes: Buffer.alloc(0), mode })
    return found
  }
  const batch = await out(git, { cwd: repoRoot, args: ["cat-file", "--batch"], input: blobs.map((path) => `${head}:${path}\n`).join(""), read: true, maxBytes: 1024 * 1024 * 1024 })
  let at = 0
  for (const path of blobs) {
    const end = batch.indexOf(10, at)
    const header = batch.toString("utf8", at, end).split(" ")
    const size = Number(header[2])
    found.set(path, { bytes: batch.subarray(end + 1, end + 1 + size), mode: modes.get(path)! })
    at = end + 1 + size + 1
  }
  for (const [path, mode] of modes) if (!found.has(path)) found.set(path, { bytes: Buffer.alloc(0), mode })
  return found
}

interface Change {
  path: string
  /** The Thread's version, or null when it deleted the file. */
  bytes: Buffer | null
  executable: boolean
}

/** The Thread's files of this repository from one partition, or `stale` when a file isn't what the journal holds yet. */
async function changesOf(input: ThreadCheckpointInput, head: string, files: readonly PartitionFile[]): Promise<{ changes: Change[]; left: ThreadCheckpoint["left"] } | "stale"> {
  const { git, repoRoot } = input
  const maxFileBytes = input.maxFileBytes ?? THREAD_CHECKPOINT_FILE_BYTES
  const left: ThreadCheckpoint["left"] = []
  const paths = files.map((file) => file.path).filter((path) => {
    if (!path.includes("\n")) return true
    left.push({ path, why: "unreadable" })
    return false
  })
  const ignored = new Set(paths.length ? split(await out(git, { cwd: repoRoot, args: ["check-ignore", "-z", "--stdin"], input: nul(paths), codes: [0, 1], read: true })) : [])
  // `check-attr -z` answers path, attribute, value, each ended by a NUL.
  const attributes = paths.length ? split(await out(git, { cwd: repoRoot, args: ["check-attr", "-z", "--stdin", "filter"], input: nul(paths), read: true })) : []
  const lfs = new Set<string>()
  for (let i = 0; i + 2 < attributes.length; i += 3) if (attributes[i + 2] === "lfs") lfs.add(attributes[i]!)
  const base = await atHead(git, repoRoot, head, paths)
  const byPath = new Map(files.map((file) => [file.path, file]))
  const read = await mapLimit(paths, PARALLEL, async (path) => ({ path, now: await onDisk(join(repoRoot, path)) }))
  const changes: Change[] = []
  for (const { path, now } of read) {
    const was = base.get(path)
    if (ignored.has(path)) left.push({ path, why: "ignored" })
    else if (was?.mode === GITLINK) left.push({ path, why: "submodule" })
    else if (lfs.has(path)) left.push({ path, why: "lfs" })
    else if (now === "other" || (was && (was.mode & 0o170000) !== 0o100000)) left.push({ path, why: "not-a-file" })
    else {
      const sides = sidesOf(byPath.get(path)!, now?.bytes ?? null, was?.bytes ?? null)
      if (sides === "stale") return "stale"
      if (sides === "unknown") left.push({ path, why: "unreadable" })
      else if (sides.thread && sides.thread.byteLength > maxFileBytes) left.push({ path, why: "too-large" })
      else if (sides.thread === null ? was !== undefined : !(was && sides.thread.equals(was.bytes))) {
        // A side that's HEAD's keeps HEAD's mode; anything else, the file's on disk.
        const executable = sides.thread === was?.bytes || !now ? Boolean(was && was.mode & 0o111) : Boolean(now.perm & 0o111)
        changes.push({ path, bytes: sides.thread, executable })
      }
    }
  }
  // Past the total, the largest go first, so the most files stay in.
  const maxBytes = input.maxBytes ?? MOVE_CHECKPOINT_MAX_BYTES
  let total = changes.reduce((sum, change) => sum + (change.bytes?.byteLength ?? 0), 0)
  const kept = new Set(changes)
  for (const change of [...changes].sort((a, b) => (b.bytes?.byteLength ?? 0) - (a.bytes?.byteLength ?? 0))) {
    if (total <= maxBytes) break
    kept.delete(change)
    total -= change.bytes?.byteLength ?? 0
    left.push({ path: change.path, why: "over-total" })
  }
  return { changes: changes.filter((change) => kept.has(change)), left }
}

/** The journal's settle, waited for until `by` at most: a capture with a deadline goes with what's settled then. */
async function settledBy(ledger: Pick<MoveLedger, "settled">, by: number | undefined): Promise<void> {
  if (by === undefined) return ledger.settled()
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([ledger.settled(), new Promise((resolve) => (timer = setTimeout(resolve, Math.max(0, by - Date.now()))))])
  clearTimeout(timer)
}

/** The repository's own files of a partition: a partition reaches every tracked root around or inside the folder. */
export function own(result: Partition, repoRoot: string): PartitionFile[] {
  const roots = new Set(result.roots.filter((root) => root.path === repoRoot).map((root) => root.root))
  return result.files.filter((file) => roots.has(file.root))
}

/**
 * What a capture of the Thread in `repoRoot` from `partition` would read, as one string: HEAD as the journal holds it,
 * and each of the Thread's files with the content the journal holds and its Thread side. Equal strings make equal
 * checkpoints, so a trigger may capture nothing when they match; only what the journal has heard is in it, so a write
 * it hasn't heard yet reads as unchanged.
 */
export function threadFingerprint(head: string | null | undefined, partition: Partition, repoRoot: string): string {
  const side = (version: PartitionFile["thread"]) => (version.kind === "absent" ? "-" : version.kind === "text" ? `t${contentRef(Buffer.from(version.text, "utf8"))}` : `c${version.ref}`)
  const files = own(partition, repoRoot).map((file) => `${file.path}\0${file.current ?? "-"}\0${side(file.thread)}`).sort()
  return [head ?? "-", ...files].join("\n")
}

/** Captures the Thread's changes in `repoRoot` over HEAD; see the top of this file. */
export async function captureThreadCheckpoint(input: ThreadCheckpointInput): Promise<ThreadCheckpoint> {
  const started = performance.now()
  const { git, ledger, repoRoot } = input
  const head = await text(git, { cwd: repoRoot, args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], codes: [0, 1], read: true })
  if (!head) throw new ThreadCheckpointRefused("no-commits", "This checkout has no commits yet, so there's nothing for a machine to start from.")
  const gitPaths = (await text(git, { cwd: repoRoot, args: ["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-path", "MERGE_HEAD", "--git-path", "rebase-merge", "--git-path", "rebase-apply", "--git-path", "CHERRY_PICK_HEAD", "--git-path", "REVERT_HEAD"], read: true })).split("\n")
  const [gitDir = "", ...operations] = gitPaths
  if ((await Promise.all(operations.map((path) => onDisk(path)))).some((found) => found !== null))
    throw new ThreadCheckpointRefused("in-progress", "This checkout is in the middle of a merge, rebase, cherry-pick or revert, so the Thread's changes can't be read on HEAD yet.")
  if ((await text(git, { cwd: repoRoot, args: ["ls-files", "-u"], read: true })).length)
    throw new ThreadCheckpointRefused("conflicts", "This checkout has conflicts to resolve first.")
  await ledger.track(repoRoot)
  await settledBy(ledger, input.by)
  // The watcher hears a write some milliseconds after it lands: a file the journal hasn't caught up with is asked again.
  let found: Awaited<ReturnType<typeof changesOf>> = "stale"
  for (let attempt = 0; attempt < ATTEMPTS && found === "stale"; attempt++) {
    if (attempt) {
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt))
      await settledBy(ledger, input.by)
    }
    if (ledger.head(repoRoot) !== head) continue
    const read = attempt === 0 && input.partition ? input.partition : await ledger.partition(repoRoot, input.thread)
    found = await changesOf(input, head, own(read, repoRoot))
  }
  if (found === "stale") throw new ThreadCheckpointRefused("changing", "Files of the Thread's were still changing, or Mako's record of them was catching up with a commit.")
  const { changes, left } = found
  const scratch = await mkdtemp(join(input.folder, "thread-"))
  try {
    const store = await privateStore(git, repoRoot, scratch)
    // The Thread's versions are staged from a folder of their own, as Git would stage them from the checkout.
    const work = join(scratch, "work")
    await mkdir(work)
    const env = { ...store.env, GIT_DIR: gitDir, GIT_WORK_TREE: work, GIT_INDEX_FILE: join(scratch, "index"), GIT_LITERAL_PATHSPECS: "1" }
    await out(git, { cwd: work, args: ["read-tree", head], env })
    const written = changes.filter((change) => change.bytes !== null)
    const removed = changes.filter((change) => change.bytes === null).map((change) => change.path)
    await mapLimit(written, PARALLEL, async ({ path, bytes, executable }) => {
      const to = join(work, path)
      await mkdir(dirname(to), { recursive: true })
      await writeFile(to, bytes!)
      await chmod(to, executable ? 0o755 : 0o644)
    })
    if (written.length) await out(git, { cwd: work, args: ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], input: nul(written.map((change) => change.path)), env })
    if (removed.length) await out(git, { cwd: work, args: ["rm", "--cached", "--quiet", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], input: nul(removed), env })
    const tree = await text(git, { cwd: work, args: ["write-tree"], env })
    const headTree = await text(git, { cwd: repoRoot, args: ["rev-parse", `${head}^{tree}`], read: true })
    const indexCommit = await commitIn(git, store, headTree, head, "index", true)
    const workCommit = await commitIn(git, store, tree, head, "work", true)
    const { checkpoint, file } = await writeCheckpoint(git, repoRoot, store, input.folder, { head, index: indexCommit, work: workCommit, branch: input.branch }, MOVE_CHECKPOINT_MAX_BYTES, true)
    const unpushed = Number(await text(git, { cwd: repoRoot, args: ["rev-list", "--count", head, "--not", "--remotes"], read: true }))
    const versions = changes.map((change) => ({ path: change.path, ref: change.bytes ? contentRef(change.bytes) : null })).sort((a, b) => a.path.localeCompare(b.path))
    return { checkpoint, file, unpushed, versions, took: changes.map((change) => change.path).sort(), left: left.sort((a, b) => a.path.localeCompare(b.path)), ms: performance.now() - started }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
