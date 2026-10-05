import { createHash, randomUUID } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GitError } from "../errors.js"
import { pathList, type Repository } from "../repository.js"
import { run, text } from "../run.js"

/**
 * What a draft describes, and how to tell it still holds. A staged snapshot
 * is the index's tree; a working-tree one is the tree the listed paths would
 * make if staged now.
 */
export type Snapshot =
  | { scope: "staged"; head: string | null; headRef: string | null; indexDigest: string | null; tree: string }
  | { scope: "working-tree"; head: string | null; headRef: string | null; indexDigest: string | null; tree: string; paths: string[] }

export interface EvidenceFile {
  path: string
  /** `A`, `M`, `D` or `T`, as Git abbreviates them. */
  change: string
  bytes: number
  /** Why the content isn't included; the file is still listed. */
  withheld?: string
}

export interface Evidence {
  files: EvidenceFile[]
  /** Each file's patch, in `files` order. */
  patches: Buffer[]
  inputBytes: number
  warnings: string[]
}

/** Two trees to compare, with what Git needs to read them. */
export interface Comparison {
  base: string
  tree: string
  /** A working-tree capture's private objects; empty for trees the repository has. */
  env: Record<string, string>
  dispose(): Promise<void>
}

const INDEX_BYTES = 64 * 1024 * 1024
const SENSITIVE = [/^\.env$/, /^\.env\..+/, /^credentials\.json$/, /^secrets\.json$/, /^id_rsa$/, /^id_ed25519$/, /\.pem$/, /\.key$/]

export function sensitivePath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1)
  return SENSITIVE.some((pattern) => pattern.test(name))
}

const PATCH_FLAGS = [
  "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--no-abbrev", "--diff-algorithm=myers", "--no-indent-heuristic",
  "--submodule=short", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3",
]

async function headRef(repository: Repository): Promise<string | null> {
  const result = await run({ cwd: repository.root, args: ["symbolic-ref", "-q", "HEAD"], codes: [1], read: true })
  return result.code === 0 ? result.stdout.toString("utf8").trim() : null
}

async function headOid(repository: Repository): Promise<string | null> {
  const result = await run({ cwd: repository.root, args: ["rev-parse", "--verify", "-q", "HEAD"], codes: [1], read: true })
  return result.code === 0 ? result.stdout.toString("utf8").trim() : null
}

async function indexDigest(repository: Repository): Promise<string | null> {
  const path = join(repository.gitDir, "index")
  try {
    if ((await stat(path)).size > INDEX_BYTES) throw new GitError({ message: "The index is larger than 64 MiB, which drafting doesn't support." })
    return createHash("sha256").update(await readFile(path)).digest("hex")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
}

/** A copy of the index Git can read but nobody else writes, with its digest. */
export async function frozenIndex(repository: Repository): Promise<{ path: string; digest: string | null; dispose(): Promise<void> }> {
  const source = join(repository.gitDir, "index")
  // Beside the original, so a split index still finds its shared part.
  const path = join(repository.gitDir, `mako-index-${randomUUID()}`)
  try {
    await copyFile(source, path)
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    return { path, digest: null, dispose: async () => {} }
  }
  const digest = createHash("sha256").update(await readFile(path)).digest("hex")
  return { path, digest, dispose: () => unlink(path).catch(() => {}) }
}

async function writeTree(repository: Repository, env: Record<string, string>): Promise<string> {
  return text({ cwd: repository.root, args: ["write-tree"], env, read: true })
}

export async function captureStaged(repository: Repository): Promise<Snapshot> {
  const [head, ref] = await Promise.all([headOid(repository), headRef(repository)])
  const frozen = await frozenIndex(repository)
  try {
    const env = { GIT_INDEX_FILE: frozen.path }
    const tree = await writeTree(repository, env)
    const changed = await run({ cwd: repository.root, args: ["diff", "--cached", "--quiet", "--no-ext-diff", "--no-textconv"], env, codes: [1], read: true })
    if (changed.code === 0) throw new GitError({ message: "Nothing is staged. Stage files first." })
    return { scope: "staged", head, headRef: ref, indexDigest: frozen.digest, tree }
  } finally {
    await frozen.dispose()
  }
}

/** A private object store and index the listed paths are staged into, leaving the repository's own untouched. */
async function privateStage(repository: Repository, head: string | null, paths: readonly string[]): Promise<{ tree: string; env: Record<string, string>; dispose(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "mako-git-"))
  const dispose = () => rm(directory, { recursive: true, force: true })
  try {
    await mkdir(join(directory, "objects"))
    const env = {
      GIT_INDEX_FILE: join(directory, "index"),
      GIT_OBJECT_DIRECTORY: join(directory, "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(repository.commonDir, "objects"),
    }
    await run({ cwd: repository.root, args: ["read-tree", head ?? "--empty"], env })
    await run({ cwd: repository.root, args: ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], input: pathList(paths), env, timeoutMs: 300_000 })
    return { tree: await writeTree(repository, env), env, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

export async function captureWorktree(repository: Repository, paths: string[]): Promise<{ snapshot: Snapshot; comparison: Comparison }> {
  const [head, ref, digest] = await Promise.all([headOid(repository), headRef(repository), indexDigest(repository)])
  const staged = await privateStage(repository, head, paths)
  const base = head ?? (await repository.emptyTree())
  return {
    snapshot: { scope: "working-tree", head, headRef: ref, indexDigest: digest, tree: staged.tree, paths },
    comparison: { base, tree: staged.tree, env: staged.env, dispose: staged.dispose },
  }
}

export async function stagedComparison(repository: Repository, snapshot: Snapshot): Promise<Comparison> {
  return { base: snapshot.head ?? (await repository.emptyTree()), tree: snapshot.tree, env: {}, dispose: async () => {} }
}

/** Throws when HEAD, the branch, or the index moved since `snapshot`. */
export async function verifyRefs(repository: Repository, snapshot: Snapshot): Promise<void> {
  const [head, ref, digest] = await Promise.all([headOid(repository), headRef(repository), indexDigest(repository)])
  if (head !== snapshot.head || ref !== snapshot.headRef) throw new GitError({ kind: "moved", message: "HEAD or branch changed since this draft. Generate a fresh draft." })
  if (digest !== snapshot.indexDigest) throw new GitError({ kind: "moved", message: "Staged changes changed since this draft. Review the index and generate a fresh draft." })
}

/** Throws when a working-tree snapshot's files no longer make the tree it recorded. */
export async function verifyFiles(repository: Repository, snapshot: Snapshot): Promise<void> {
  if (snapshot.scope !== "working-tree") return
  const again = await privateStage(repository, snapshot.head, snapshot.paths)
  await again.dispose()
  if (again.tree !== snapshot.tree) throw new GitError({ kind: "moved", message: "A selected working file changed since this draft. Generate a fresh draft." })
}

/**
 * Every changed file between the two trees and its patch, up to `limit`
 * bytes of patches. Sensitive files are listed with their content withheld.
 */
export async function readEvidence(repository: Repository, comparison: Comparison, limit: number, signal: AbortSignal): Promise<Evidence> {
  const listing = await run({ cwd: repository.root, args: ["diff-tree", "-r", "-z", "--name-status", "--no-renames", comparison.base, comparison.tree, "--"], env: comparison.env, read: true, signal })
  const fields = listing.stdout.toString("utf8").split("\0")
  const files: EvidenceFile[] = []
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const change = fields[at]!.trim()
    if (change) files.push({ path: fields[at + 1]!, change: change[0]!, bytes: 0 })
  }
  if (files.length === 0) throw new GitError({ message: "There are no changes to describe." })
  const withheld = files.filter((file) => sensitivePath(file.path))
  for (const file of withheld) file.withheld = "Sensitive filename: content withheld"
  const read = files.filter((file) => !file.withheld)
  const patches = new Map<EvidenceFile, Buffer>()
  if (read.length > 0) {
    const result = await run({
      cwd: repository.root,
      args: ["diff", ...PATCH_FLAGS, comparison.base, comparison.tree, "--", ...withheld.map((file) => `:(exclude,literal)${file.path}`)],
      env: comparison.env,
      maxBytes: limit,
      timeoutMs: 300_000,
      read: true,
      signal,
    })
    if (result.truncated) throw new GitError({ message: `These changes are too large to describe with this model: more than ${Math.round(limit / 1_048_576)} MB of patches. Commit them in smaller parts, or choose a model that reads more at once.` })
    const pieces = splitPatches(result.stdout)
    if (pieces.length !== read.length) throw new GitError({ message: "Git's patches didn't match the changed files. Try again." })
    read.forEach((file, index) => patches.set(file, pieces[index]!))
  }
  const ordered = files.map((file) => patches.get(file) ?? Buffer.from(file.withheld ?? ""))
  files.forEach((file, index) => { file.bytes = ordered[index]!.length })
  const warnings = withheld.length > 0 ? [`${withheld.length} sensitive ${withheld.length === 1 ? "file" : "files"}: metadata included, content withheld.`] : []
  return { files, patches: ordered, inputBytes: ordered.reduce((sum, patch) => sum + patch.length, 0), warnings }
}

const HEADER = Buffer.from("diff --git ")

/** One piece per file: each starts at a `diff --git` line. */
function splitPatches(output: Buffer): Buffer[] {
  const starts: number[] = []
  if (output.subarray(0, HEADER.length).equals(HEADER)) starts.push(0)
  for (let at = output.indexOf(Buffer.from(`\n${HEADER.toString()}`)); at >= 0; at = output.indexOf(Buffer.from(`\n${HEADER.toString()}`), at + 1)) starts.push(at + 1)
  return starts.map((start, index) => output.subarray(start, starts[index + 1] ?? output.length))
}

/** The commit a branch left `base` at, and the commits it has since, oldest first. */
export async function branchRange(repository: Repository, base: string, signal: AbortSignal): Promise<{ baseRef: string; mergeBase: string; tree: string; commits: string[] }> {
  let baseRef: string | undefined
  for (const candidate of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) {
    const found = await run({ cwd: repository.root, args: ["rev-parse", "--verify", "-q", `${candidate}^{commit}`], codes: [1], read: true, signal })
    if (found.code === 0) {
      baseRef = candidate
      break
    }
  }
  if (!baseRef) throw new GitError({ message: `${base} isn't here. Fetch, then try again.` })
  const mergeBase = await text({ cwd: repository.root, args: ["merge-base", baseRef, "HEAD"], read: true, signal })
  const tree = await text({ cwd: repository.root, args: ["rev-parse", "HEAD^{tree}"], read: true, signal })
  const log = await run({ cwd: repository.root, args: ["log", "--reverse", "-z", "--max-count=200", "--format=%h %s", `${mergeBase}..HEAD`, "--"], read: true, signal })
  const commits = log.stdout.toString("utf8").split("\0").map((line) => line.trim()).filter(Boolean)
  if (commits.length === 0) throw new GitError({ message: `This branch has no commits beyond ${base}. Commit first.` })
  return { baseRef, mergeBase, tree, commits }
}
