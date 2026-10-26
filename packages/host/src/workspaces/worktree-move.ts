import type { Git } from "@mako/git"
import { createHash } from "node:crypto"
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { z } from "zod"
import { contentRef, diffLines, splitLines, type Attribution, type CheckoutShares, type ChangeClass, type Partition, type PartitionFile, type Share } from "../attribution/index.js"
import type { MoveOutcome, MoveShare, MoveShares } from "../contracts/workspace-moves.js"
import { copyGitIndex } from "./index-copy.js"

/*
 * Moving a Thread's uncommitted changes from the main checkout into its new
 * worktree, by author. The journal (`attribution/`) says who last wrote each
 * line; the worktree gets the base plus the Thread's lines, and the main
 * checkout loses exactly those and keeps everyone else's. Lines that might
 * be the Thread's, and those nobody can be named for, stay unless the person
 * brings them.
 *
 * Every file's part is a transition between two versions on each side,
 * named by Git blob ids of the bytes as they are on disk (`hash-object
 * --no-filters`), so a write is checked against what is there before it is
 * made and after. The order makes it all-or-nothing:
 *
 *   1. plan: read each file the Thread wrote, check it is what the journal
 *      holds, divide it, and check the two sides add back up to it, line for
 *      line; store every version in the repository's object store;
 *   2. back up: the main checkout's whole state, files and index, as a commit
 *      under `refs/mako/moves/<id>`, kept 14 days;
 *   3. write the plan down (`save`), then the worktree, the main checkout and
 *      its index, each file replaced by a rename so it is never half-written;
 *   4. read both sides back. Anything off rolls every repository back.
 *
 * A move cut short is found by its saved plan: when every file on both sides
 * is either as it was or as the plan wants, it rolls forward; otherwise it
 * rolls back, leaving any file someone changed since as they left it.
 */

/** What a move needs of the attribution journal. */
export type MoveLedger = Pick<Attribution, "settled" | "track" | "head" | "partition" | "shares" | "mako"> & Partial<Pick<Attribution, "readBack" | "moved">>

/** How long a move, or its card, waits on sessions' records naming lines nobody is sure of. */
const READ_BACK_MS = 3_000

export const BACKUP_REFS = "refs/mako/moves/"
export const BACKUP_KEPT_MS = 14 * 86_400_000
/** Paths listed per kind in an outcome; the counts are whole. */
const LISTED = 100
const IDENTITY = { GIT_AUTHOR_NAME: "Mako", GIT_AUTHOR_EMAIL: "mako@localhost", GIT_COMMITTER_NAME: "Mako", GIT_COMMITTER_EMAIL: "mako@localhost" }
const PARALLEL = 16

const Oid = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/)

/** One version of a file on disk: its blob id and permission bits; null for no file. */
const VersionSchema = z.object({ oid: Oid, perm: z.number().int().min(0).max(0o777) }).nullable()
export type Version = NonNullable<z.infer<typeof VersionSchema>>

/** One file's part in a move, relative to its repository. */
const MovePathSchema = z.object({
  path: z.string().min(1),
  how: z.enum(["whole", "lines"]),
  /** In the worktree before: the base. */
  base: VersionSchema,
  /** In the main checkout before. */
  before: VersionSchema,
  /** The worktree after: the base plus the Thread's lines. */
  thread: VersionSchema,
  /** The main checkout after: everything else. */
  remaining: VersionSchema,
})
export type MovePath = z.infer<typeof MovePathSchema>

/** An index entry of the main checkout the move changes, as `<mode> <oid>`; null for none. */
const IndexChangeSchema = z.object({
  path: z.string().min(1),
  from: z.string().nullable(),
  to: z.string().nullable(),
  /** It was staged in part and some of it stayed, so it is now unstaged. */
  unstaged: z.literal(true).optional(),
})
export type IndexChange = z.infer<typeof IndexChangeSchema>

const RepositoryPlanSchema = z.object({
  repoRoot: z.string(),
  worktree: z.string(),
  head: z.string(),
  /** Blob ids are SHA-1 or SHA-256, as the repository's objects are. */
  format: z.enum(["sha1", "sha256"]),
  /** The main checkout's state before the move, under `refs/mako/moves/`; null when nothing moves. */
  backup: z.string().nullable(),
  paths: z.array(MovePathSchema),
  index: z.array(IndexChangeSchema),
  /** The same move with the uncertain and unattributed lines brought: what "Bring these" changes afterwards. */
  bring: z.array(MovePathSchema),
})
export type RepositoryPlan = z.infer<typeof RepositoryPlanSchema>

const MoveShareSchema = z.object({ files: z.number().int().nonnegative(), lines: z.number().int().nonnegative(), paths: z.array(z.string()) })
export const MoveOutcomeSchema = z.object({
  came: MoveShareSchema,
  likely: MoveShareSchema.optional(),
  returned: z.array(z.string()).optional(),
  stayed: z.object({ others: MoveShareSchema, person: MoveShareSchema, uncertain: MoveShareSchema, unattributed: MoveShareSchema, kept: z.number().int().nonnegative().optional() }),
  split: z.array(z.object({ path: z.string(), to: z.enum(["thread", "checkout"]) })),
  brought: z.boolean(),
  unstaged: z.array(z.string()),
  backup: z.string().optional(),
}) satisfies z.ZodType<MoveOutcome>

export const MovePlanSchema = z.object({
  id: z.string().uuid(),
  thread: z.string(),
  at: z.number(),
  /** `writing` once the plan is saved and before the first write; `done` once both sides are checked. */
  step: z.enum(["writing", "done"]),
  brought: z.boolean(),
  /** Saved before "Bring these" or "Put back" writes, so a start that finds it finishes them from this plan. */
  adjusting: z.union([z.object({ kind: z.literal("bring") }), z.object({ kind: z.literal("put-back"), paths: z.array(z.string()) })]).optional(),
  repositories: z.array(RepositoryPlanSchema),
  outcome: MoveOutcomeSchema,
})
export type MovePlan = z.infer<typeof MovePlanSchema>

/** What "Bring these" and "Put back" call before they write, and at each step. */
export interface AdjustHooks {
  save?(plan: MovePlan): Promise<void>
  stepped?(step: string): void
}

export interface MoveInput {
  git: Git
  /** Absent when the journal isn't open: then nothing is attributed, and only "Bring these" moves anything. */
  ledger: MoveLedger | undefined
  id: string
  thread: string
  branch: string
  /** The project folder, which an outcome's paths are relative to. */
  project: string
  members: readonly { repoRoot: string; path: string; base: string }[]
  bring: boolean
  /** Keep the plan where a later start finds it; undefined once it needs no finishing. */
  save(plan: MovePlan | undefined): Promise<void>
  log(message: string, facts: Record<string, string | number | boolean>): void
  /** Each step as it's reached, for a test that stops the process there. */
  stepped?: (step: string) => void
}

/** Why a move didn't happen, said to the agent and the person; nothing was changed. */
export class MoveRefused extends Error {}

/** The Git blob id of `bytes`, as `hash-object` gives it. */
function blobId(bytes: Uint8Array, format: "sha1" | "sha256"): string {
  return createHash(format).update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex")
}

/** What a file is on disk: its bytes and permission bits; null for no regular file there. */
async function onDisk(path: string): Promise<{ bytes: Buffer; perm: number } | null | "other"> {
  const stat = await lstat(path).catch(() => null)
  if (!stat) return null
  if (!stat.isFile()) return "other"
  return { bytes: await readFile(path), perm: stat.mode & 0o777 }
}

async function mapLimit<T, R>(values: readonly T[], limit: number, map: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  const queue = values.entries()
  const worker = async () => {
    for (const [index, value] of queue) results[index] = await map(value)
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker))
  return results
}

/** Byte lines, each with its newline, as a multiset. */
function lineCounts(into: Map<string, number>, bytes: Buffer | undefined, sign: 1 | -1): void {
  if (!bytes) return
  let start = 0
  while (start < bytes.length) {
    const end = bytes.indexOf(10, start)
    const stop = end < 0 ? bytes.length : end + 1
    const line = bytes.toString("latin1", start, stop)
    into.set(line, (into.get(line) ?? 0) + sign)
    start = stop
  }
}

/**
 * Whether the two sides of a file add back up to what the main checkout had:
 * a whole file is on one side as it was and on the other as the base had it;
 * a divided file's lines, with the base's, are the same lines as the two
 * sides', each kept once.
 */
export function accountsFor(path: MovePath, bytes: ReadonlyMap<string, Buffer>): string | undefined {
  const oid = (version: Version | null) => version?.oid ?? null
  if (path.how === "whole") {
    const same = oid(path.thread) === oid(path.before) && oid(path.remaining) === oid(path.base)
    const kept = oid(path.thread) === oid(path.base) && oid(path.remaining) === oid(path.before)
    return same || kept ? undefined : `${path.path}: a whole file must go to one side as it was`
  }
  const counts = new Map<string, number>()
  const of = (version: Version | null) => (version ? bytes.get(version.oid) : undefined)
  lineCounts(counts, of(path.before), 1)
  lineCounts(counts, of(path.base), 1)
  lineCounts(counts, of(path.thread), -1)
  lineCounts(counts, of(path.remaining), -1)
  for (const [line, count] of counts)
    if (count !== 0) return `${path.path}: ${count > 0 ? "a line would be lost" : "a line would be doubled"} (${JSON.stringify(line.slice(0, 60))})`
  return undefined
}

/** Store versions in the repository's object store, so a move cut short can finish or undo from them. */
async function storeBlobs(git: Git, repoRoot: string, blobs: ReadonlyMap<string, Buffer>): Promise<void> {
  if (!blobs.size) return
  const directory = await mkdtemp(join(tmpdir(), "mako-move-"))
  try {
    const entries = [...blobs]
    const sources = await mapLimit(entries, PARALLEL, async ([oid, bytes]) => {
      const source = join(directory, oid)
      await writeFile(source, bytes)
      return source
    })
    const stored = (await git.text({ cwd: repoRoot, args: ["hash-object", "-w", "--no-filters", "--stdin-paths"], input: `${sources.join("\n")}\n` })).split("\n")
    entries.forEach(([oid], index) => {
      if (stored[index] !== oid) throw new MoveRefused(`Git stored a version of a moving file under another id (${stored[index] ?? "none"}), so nothing moved.`)
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Read stored versions back, for a move resumed or undone by another process. */
async function loadBlobs(git: Git, repoRoot: string, oids: Iterable<string>): Promise<Map<string, Buffer>> {
  const wanted = [...new Set(oids)]
  const out = new Map<string, Buffer>()
  if (!wanted.length) return out
  const { stdout } = await git.run({ cwd: repoRoot, args: ["cat-file", "--batch"], input: `${wanted.join("\n")}\n`, maxBytes: 2 * 1024 ** 3, read: true })
  let at = 0
  for (const oid of wanted) {
    const header = stdout.indexOf(10, at)
    const [, kind, size] = stdout.toString("utf8", at, header).split(" ")
    if (kind !== "blob") throw new Error(`The move's stored version ${oid} is gone from ${repoRoot}.`)
    const start = header + 1
    out.set(oid, stdout.subarray(start, start + Number(size)))
    at = start + Number(size) + 1
  }
  return out
}

/**
 * The main checkout as it is, files and index, as one commit kept under
 * `ref`: its tree the working files (untracked ones too, ignored ones not),
 * its second parent the index, as `git stash` keeps them. Neither the
 * checkout's files nor its index are touched.
 */
async function backUp(git: Git, repoRoot: string, head: string, ref: string, message: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "mako-move-index-"))
  try {
    const index = join(directory, "index")
    const real = resolve(repoRoot, await git.output(repoRoot, ["rev-parse", "--git-path", "index"]))
    await copyGitIndex(real, index).catch(() => undefined)
    const env = { GIT_INDEX_FILE: index }
    await git.run({ cwd: repoRoot, args: ["add", "-A", "--", "."], env })
    const tree = await git.text({ cwd: repoRoot, args: ["write-tree"], env })
    const staged = await git.text({ cwd: repoRoot, args: ["write-tree"] })
    const indexCommit = await git.text({ cwd: repoRoot, args: ["commit-tree", staged, "-p", head, "-m", "index before the move"], env: IDENTITY })
    const commit = await git.text({ cwd: repoRoot, args: ["commit-tree", tree, "-p", head, "-p", indexCommit, "-m", message], env: IDENTITY })
    await git.run({ cwd: repoRoot, args: ["update-ref", "-m", message, ref, commit] })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** `backUp`, unless `ref` is kept already: an adjustment finished after a restart keeps the state before its first try. */
async function backUpOnce(git: Git, repoRoot: string, head: string, ref: string, message: string): Promise<void> {
  if (await git.succeeds(repoRoot, ["rev-parse", "--verify", "--quiet", ref])) return
  await backUp(git, repoRoot, head, ref, message)
}

/** Drop backups older than 14 days. */
export async function pruneBackups(git: Git, repoRoot: string, now = Date.now()): Promise<number> {
  const listed = await git.output(repoRoot, ["for-each-ref", "--format=%(refname) %(committerdate:unix)", BACKUP_REFS]).catch(() => "")
  let dropped = 0
  for (const line of listed.split("\n")) {
    const [ref, at] = line.split(" ")
    if (!ref || !at || now - Number(at) * 1000 < BACKUP_KEPT_MS) continue
    if (await git.succeeds(repoRoot, ["update-ref", "-d", ref])) dropped++
  }
  return dropped
}

/**
 * One partition file's sides, from the bytes in both checkouts: `stale` when
 * the main checkout's file isn't what the journal holds yet, `unknown` when a
 * side is neither checkout's version (a filter rewrote the base, say).
 */
type Sides = { thread: Buffer | null; remaining: Buffer | null } | "stale" | "unknown"

function sidesOf(file: PartitionFile, before: Buffer | null, base: Buffer | null): Sides {
  const ref = (bytes: Buffer | null) => (bytes ? contentRef(bytes) : null)
  if (ref(before) !== file.current) return "stale"
  const version = (side: PartitionFile["thread"]): Buffer | null | "unknown" => {
    if (side.kind === "absent") return null
    if (side.kind === "text") return Buffer.from(side.text, "utf8")
    if (side.ref === ref(before)) return before
    if (side.ref === ref(base)) return base
    return "unknown"
  }
  const thread = version(file.thread)
  const remaining = version(file.remaining)
  return thread === "unknown" || remaining === "unknown" ? "unknown" : { thread, remaining }
}

interface Planned {
  plan: RepositoryPlan
  bytes: Map<string, Buffer>
  shares: CheckoutShares
  whole: Partition["whole"]
}

/** Every changed path when there's no journal: nobody is named, so each goes whole if brought. */
async function everything(git: Git, repoRoot: string): Promise<string[]> {
  const listed = await git.run({ cwd: repoRoot, args: ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], read: true })
  return listed.stdout.toString("utf8").split("\0").filter(Boolean).map((entry) => entry.slice(3))
}

/** The journal's view of one repository, or `stale` when a file there isn't what it holds yet. */
async function planRepository(input: MoveInput, member: MoveInput["members"][number], format: "sha1" | "sha256"): Promise<Planned | "stale"> {
  const { git, ledger, thread } = input
  const { repoRoot, path: worktree } = member
  const bytes = new Map<string, Buffer>()
  const keep = (buffer: Buffer | null) => {
    if (!buffer) return null
    const oid = blobId(buffer, format)
    bytes.set(oid, buffer)
    return oid
  }
  let taken: PartitionFile[]
  let all: PartitionFile[]
  let shares: CheckoutShares
  let whole: Partition["whole"] = []
  if (ledger) {
    // Only this repository's files: a partition reaches every tracked root around or inside the folder.
    const own = (result: Partition) => {
      const roots = new Set(result.roots.filter((root) => root.path === repoRoot).map((root) => root.root))
      return result.files.filter((file) => roots.has(file.root))
    }
    const moving = ledger.partition(repoRoot, thread, { bring: input.bring })
    taken = own(moving)
    all = input.bring ? taken : own(ledger.partition(repoRoot, thread, { bring: true }))
    shares = ledger.shares(repoRoot, thread)
    whole = moving.whole
  } else {
    const paths = await everything(git, repoRoot)
    const files = await mapLimit(paths, PARALLEL, async (path) => {
      const [now, base] = await Promise.all([onDisk(join(repoRoot, path)), onDisk(join(worktree, path))])
      const ref = (found: typeof now) => (found && found !== "other" ? contentRef(found.bytes) : null)
      const file: PartitionFile = { root: repoRoot, path, move: "whole", current: ref(now), thread: ref(now) ? { kind: "content", ref: ref(now)! } : { kind: "absent" }, remaining: ref(base) ? { kind: "content", ref: ref(base)! } : { kind: "absent" } }
      return file
    })
    taken = input.bring ? files : []
    all = files
    const none = { files: [], lines: 0 }
    shares = { thread: { ...none, files: [] }, likely: { ...none, files: [] }, others: { ...none, files: [] }, person: { ...none, files: [] }, uncertain: { ...none, files: [] }, unattributed: { files: paths.map((path) => join(repoRoot, path)), lines: 0 } }
  }
  const byPath = new Map<string, { taken?: PartitionFile; all?: PartitionFile }>()
  for (const file of taken) byPath.set(file.path, { ...byPath.get(file.path), taken: file })
  for (const file of all) byPath.set(file.path, { ...byPath.get(file.path), all: file })
  const paths = [...byPath.keys()].sort()
  // The recipe's carry tracks ignored files; they reach a worktree by the carry, never by a move.
  const ignored = new Set(paths.length
    ? (await git.run({ cwd: repoRoot, args: ["check-ignore", "-z", "--stdin"], input: `${paths.join("\0")}\0`, codes: [1], read: true })).stdout.toString("utf8").split("\0").filter(Boolean)
    : [])
  // The worktree's files are its base only while nobody has changed them there; a move never writes over that.
  const touched = paths.length
    ? (await git.run({ cwd: worktree, args: ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", ...paths.map((path) => `:(literal)${path}`)], read: true })).stdout.toString("utf8").split("\0").filter(Boolean).map((entry) => entry.slice(3))
    : []
  if (touched.length)
    throw new MoveRefused(`The worktree already has changes to ${touched.slice(0, 3).join(", ")}${touched.length > 3 ? ` and ${touched.length - 3} more` : ""}, so the main checkout's stayed where they are.`)
  const read = await mapLimit(paths, PARALLEL, async (path) => ({ path, before: await onDisk(join(repoRoot, path)), base: await onDisk(join(worktree, path)) }))
  const plan: RepositoryPlan = { repoRoot, worktree, head: member.base, format, backup: null, paths: [], index: [], bring: [] }
  for (const { path, before, base } of read) {
    if (ignored.has(path) || path.includes("\n")) continue
    if (before === "other" || base === "other") {
      input.log("a path that isn't a file stays", { repository: repoRoot, path })
      continue
    }
    const both = byPath.get(path)!
    const beforeOid = keep(before?.bytes ?? null)
    const baseOid = keep(base?.bytes ?? null)
    const version = (oid: string | null, perm: number | undefined): Version | null => (oid ? { oid, perm: perm ?? 0o644 } : null)
    const was = { base: version(baseOid, base?.perm), before: version(beforeOid, before?.perm) }
    const pathOf = (file: PartitionFile): MovePath | "stale" | undefined => {
      const sides = sidesOf(file, before?.bytes ?? null, base?.bytes ?? null)
      if (sides === "stale") return "stale"
      if (sides === "unknown") {
        input.log("a file whose base Mako can't read as Git checks it out stays", { repository: repoRoot, path })
        return undefined
      }
      // A side that's the base keeps the base's permissions; anything else, the checkout's.
      const perm = (buffer: Buffer | null) => (buffer && buffer === base?.bytes ? base.perm : before?.perm ?? base?.perm)
      return { path, how: file.move, ...was, thread: version(keep(sides.thread), perm(sides.thread)), remaining: version(keep(sides.remaining), perm(sides.remaining)) }
    }
    const moved = both.taken ? pathOf(both.taken) : undefined
    const brought = both.all ? pathOf(both.all) : undefined
    if (moved === "stale" || brought === "stale") return "stale"
    if (moved) plan.paths.push(moved)
    // "Bring these" later: from what this move leaves to the move with everything brought.
    const after = moved ?? { path, how: "whole" as const, ...was, thread: was.base, remaining: was.before }
    if (brought && (brought.thread?.oid !== after.thread?.oid || brought.remaining?.oid !== after.remaining?.oid)) plan.bring.push(brought)
  }
  for (const path of [...plan.paths, ...plan.bring]) {
    const broken = accountsFor(path, bytes)
    if (broken) throw new MoveRefused(`Mako couldn't divide ${relative(input.project, join(repoRoot, path.path)) || path.path} so that both checkouts add up to it, so nothing moved (${broken}).`)
  }
  plan.index = await indexChanges(git, repoRoot, member.base, plan.paths)
  return { plan, bytes, shares, whole }
}

/**
 * What the main checkout's index needs so it stays true to its files: a
 * path staged whole is staged as it now is, or unstaged when nothing of it
 * stayed; one staged in part is unstaged, since its parts may have left.
 */
async function indexChanges(git: Git, repoRoot: string, head: string, paths: readonly MovePath[]): Promise<IndexChange[]> {
  if (!paths.length) return []
  const literal = paths.map((path) => `:(literal)${path.path}`)
  const [index, committed] = await Promise.all([
    stagedEntries(git, repoRoot, paths.map((path) => path.path)),
    git.run({ cwd: repoRoot, args: ["ls-tree", "-z", head, "--", ...literal], read: true }),
  ])
  const entries = (text: string, parse: (record: string) => [string, string] | undefined) => new Map(text.split("\0").map(parse).filter((pair) => pair !== undefined))
  const base = entries(committed.stdout.toString("utf8"), (record) => {
    const tab = record.indexOf("\t")
    if (tab < 0) return undefined
    const [mode, , oid] = record.slice(0, tab).split(" ")
    return [record.slice(tab + 1), `${mode} ${oid}`]
  })
  const out: IndexChange[] = []
  for (const path of paths) {
    const now = index.get(path.path) ?? null
    const was = base.get(path.path) ?? null
    if (now === was) continue
    const mode = now?.split(" ")[0] ?? "100644"
    const whole = now && now.split(" ")[1] === path.before?.oid
    const nothingStayed = path.remaining?.oid === path.base?.oid
    const to = nothingStayed ? was : whole && path.remaining ? `${mode} ${path.remaining.oid}` : was
    if (to === now) continue
    out.push(!nothingStayed && !whole ? { path: path.path, from: now, to, unstaged: true } : { path: path.path, from: now, to })
  }
  return out
}

/** A side of a transition: what a file goes from and to. */
interface Write {
  path: string
  from: Version | null
  to: Version | null
}

/** Where a repository keeps a move's files as they're written, on the same volume, so each lands by a rename. */
async function scratch(git: Git, folder: string): Promise<string> {
  const gitDir = await git.output(folder, ["rev-parse", "--absolute-git-dir"])
  const directory = join(gitDir, "mako-move")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  return directory
}

/** What each path holds now: done when it's `to` already, ready when it's `from`, else someone changed it. */
async function states(folder: string, writes: readonly Write[], format: "sha1" | "sha256"): Promise<("done" | "ready" | "changed")[]> {
  return mapLimit(writes, PARALLEL, async (write) => {
    const found = await onDisk(join(folder, write.path))
    const oid = found === "other" ? "other" : found ? blobId(found.bytes, format) : null
    if (oid === (write.to?.oid ?? null)) return "done"
    if (oid === (write.from?.oid ?? null)) return "ready"
    return "changed"
  })
}

/** Write each path to its `to`, a rename at a time; empty folders a removal leaves go too. */
async function writeAll(folder: string, writes: readonly Write[], bytes: ReadonlyMap<string, Buffer>, directory: string, each?: () => void): Promise<void> {
  await mapLimit(writes, PARALLEL, async (write) => {
    const target = join(folder, write.path)
    if (!write.to) {
      await unlink(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      })
      await pruneEmpty(folder, dirname(target))
      each?.()
      return
    }
    const content = bytes.get(write.to.oid)
    if (!content) throw new Error(`The move lost the version of ${write.path} it meant to write.`)
    await mkdir(dirname(target), { recursive: true })
    const pending = join(directory, `${write.to.oid}-${Math.random().toString(36).slice(2)}`)
    await writeFile(pending, content, { mode: write.to.perm })
    await chmod(pending, write.to.perm)
    await rename(pending, target).catch(async (error: NodeJS.ErrnoException) => {
      // Another volume: write in place.
      if (error.code !== "EXDEV") throw error
      await rm(pending, { force: true })
      await writeFile(target, content, { mode: write.to!.perm })
      await chmod(target, write.to!.perm)
    })
    each?.()
  })
}

async function pruneEmpty(root: string, folder: string): Promise<void> {
  for (let at = folder; at !== root && relative(root, at) && !relative(root, at).startsWith(".."); at = dirname(at)) {
    if ((await readdir(at).catch(() => ["?"])).length) return
    await rmdir(at).catch(() => undefined)
  }
}

/** Set index entries of the main checkout; `entry` null removes the path. */
async function setIndex(git: Git, repoRoot: string, entries: readonly { path: string; entry: string | null }[], format: "sha1" | "sha256"): Promise<void> {
  if (!entries.length) return
  const none = "0".repeat(format === "sha1" ? 40 : 64)
  const input = entries.map(({ path, entry }) => `${entry ?? `0 ${none}`}\t${path}\0`).join("")
  await git.run({ cwd: repoRoot, args: ["update-index", "-z", "--index-info"], input })
}

const forward = (plan: RepositoryPlan, paths: readonly MovePath[]) => ({
  worktree: paths.filter((path) => path.thread?.oid !== path.base?.oid).map((path) => ({ path: path.path, from: path.base, to: path.thread })),
  main: paths.filter((path) => path.remaining?.oid !== path.before?.oid).map((path) => ({ path: path.path, from: path.before, to: path.remaining })),
  plan,
})

const backward = (writes: readonly Write[]): Write[] => writes.map((write) => ({ path: write.path, from: write.to, to: write.from }))

/**
 * Apply a plan's writes, worktree first, then the main checkout and its
 * index. With `strict`, any file that is neither as the plan found it nor as
 * it wants refuses the whole move before anything is written.
 */
async function applyWrites(git: Git, ledger: Pick<MoveLedger, "mako"> | undefined, repositories: readonly { plan: RepositoryPlan; worktree: Write[]; main: Write[]; index: { path: string; entry: string | null }[] }[], bytes: ReadonlyMap<string, Buffer>, strict: boolean, each?: () => void): Promise<string[]> {
  const pending: { folder: string; writes: Write[]; directory: string }[] = []
  const left: string[] = []
  for (const { plan, worktree, main } of repositories) {
    for (const [folder, writes] of [[plan.worktree, worktree], [plan.repoRoot, main]] as const) {
      const found = await states(folder, writes, plan.format)
      const changed = writes.filter((_, index) => found[index] === "changed").map((write) => relative(plan.repoRoot, join(folder, write.path)) || write.path)
      if (changed.length && strict) throw new MoveRefused(`${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ` and ${changed.length - 5} more` : ""} changed while the move was under way, so nothing moved.`)
      left.push(...writes.filter((_, index) => found[index] === "changed").map((write) => join(folder, write.path)))
      pending.push({ folder, writes: writes.filter((_, index) => found[index] === "ready"), directory: await scratch(git, folder) })
    }
  }
  const paths = pending.flatMap(({ folder, writes }) => writes.map((write) => join(folder, write.path)))
  const writing = paths.length ? ledger?.mako({ kind: "move", operation: "worktree move", paths: paths.length <= 4096 ? paths : [...new Set(pending.map(({ folder }) => folder))] }) : undefined
  try {
    for (const { folder, writes, directory } of pending) await writeAll(folder, writes, bytes, directory, each)
    for (const { plan, index } of repositories) await setIndex(git, plan.repoRoot, index, plan.format)
  } finally {
    writing?.end()
  }
  return left
}

/** Whether every write landed: each file is now exactly its `to`. */
async function landed(repositories: readonly { plan: RepositoryPlan; worktree: Write[]; main: Write[] }[]): Promise<string | undefined> {
  for (const { plan, worktree, main } of repositories)
    for (const [folder, writes] of [[plan.worktree, worktree], [plan.repoRoot, main]] as const) {
      const found = await states(folder, writes, plan.format)
      const off = writes.find((_, index) => found[index] !== "done")
      if (off) return `${join(folder, off.path)} isn't what the move wrote`
    }
  return undefined
}

/** Undo a plan's writes, leaving any file someone changed since as it is; names those left. */
async function undo(git: Git, ledger: Pick<MoveLedger, "mako"> | undefined, plan: MovePlan, bytes: ReadonlyMap<string, Buffer>, paths: (repository: RepositoryPlan) => MovePath[]): Promise<string[]> {
  const repositories = plan.repositories.map((repository) => {
    const { worktree, main } = forward(repository, paths(repository))
    const index = repository.index.filter((change) => paths(repository).some((path) => path.path === change.path)).map((change) => ({ path: change.path, entry: change.from }))
    return { plan: repository, worktree: backward(worktree), main: backward(main), index }
  })
  return applyWrites(git, ledger, repositories, bytes, false)
}

/** Paths relative to the project folder, the first `LISTED` of them, with their count. */
function shareOf(project: string, shares: readonly Share[]): MoveShare {
  const files = [...new Set(shares.flatMap((share) => share.files))].sort()
  return { files: files.length, lines: shares.reduce((sum, share) => sum + share.lines, 0), paths: files.slice(0, LISTED).map((path) => relative(project, path) || path) }
}

/** How a checkout's changes divide, as the move card and `worktree_status` say it. */
export function moveShares(project: string, shares: readonly CheckoutShares[], whole: readonly { root: string; path: string; to: "thread" | "checkout" }[] = []): MoveShares {
  const of = (kind: ChangeClass | "likely") => shareOf(project, shares.map((share) => share[kind]))
  return {
    thread: of("thread"),
    likely: of("likely"),
    others: of("others"),
    person: of("person"),
    uncertain: of("uncertain"),
    unattributed: of("unattributed"),
    split: whole.map((hunk) => ({ path: relative(project, join(hunk.root, hunk.path)) || hunk.path, to: hunk.to })),
    kept: new Set(shares.flatMap((share) => [...share.others.files, ...share.person.files])).size,
  }
}

/** The repository's object format, which blob ids follow. */
async function objectFormat(git: Git, repoRoot: string): Promise<"sha1" | "sha256"> {
  return (await git.output(repoRoot, ["rev-parse", "--show-object-format"]).catch(() => "sha1")) === "sha256" ? "sha256" : "sha1"
}

/**
 * Move the Thread's changes into its worktree; see the top of this file.
 * Throws `MoveRefused` with nothing changed, or a plain error once a move
 * was rolled back.
 */
export async function moveByAuthor(input: MoveInput): Promise<MovePlan> {
  const { git, ledger, members } = input
  const started = performance.now()
  for (const { repoRoot } of members) await pruneBackups(git, repoRoot).catch(() => 0)
  for (const { repoRoot, path, base } of members) {
    const [head, at] = await Promise.all([git.output(repoRoot, ["rev-parse", "HEAD"]), git.output(path, ["rev-parse", "HEAD"])])
    if (head !== base || at !== base)
      throw new MoveRefused(`${members.length > 1 ? relative(input.project, repoRoot) : "The main checkout"} moved to another commit while the worktree was made, so its changes stayed where they are.`)
    if ((await git.output(repoRoot, ["ls-files", "-u"])).length)
      throw new MoveRefused(`${members.length > 1 ? relative(input.project, repoRoot) : "The main checkout"} is in the middle of a merge, so its changes stayed where they are. Finish or abort it, then move.`)
  }
  if (ledger) {
    for (const { repoRoot } of members) await ledger.track(repoRoot)
    await ledger.settled()
    for (const { repoRoot } of members) await ledger.readBack?.(repoRoot, READ_BACK_MS)
  }
  input.stepped?.("planning")
  // The watcher hears a write some milliseconds after it lands: a file the journal hasn't caught up with is asked again.
  let planned: Planned[] | undefined
  for (let attempt = 0; attempt < 4 && !planned; attempt++) {
    if (attempt) {
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt))
      await ledger?.settled()
    }
    const found: Planned[] = []
    for (const member of members) {
      if (ledger && ledger.head(member.repoRoot) !== member.base) break
      const result = await planRepository(input, member, await objectFormat(git, member.repoRoot))
      if (result === "stale") break
      found.push(result)
    }
    if (found.length === members.length) planned = found
  }
  if (!planned) throw new MoveRefused("Files Mako was dividing were still changing, or its record of them was catching up with a commit, so nothing moved. Try again in a moment.")
  const planMs = performance.now() - started
  const bytes = new Map(planned.flatMap((entry) => [...entry.bytes]))
  const repositories = planned.map((entry) => entry.plan)
  const moving = repositories.some((repository) => repository.paths.length)
  const shares = moveShares(input.project, planned.map((entry) => entry.shares), planned.flatMap((entry) => entry.whole.map((hunk) => ({ root: entry.plan.repoRoot, path: hunk.path, to: hunk.to }))))
  const brought = input.bring
  const named = (repository: RepositoryPlan, path: string) => relative(input.project, join(repository.repoRoot, path)) || path
  const moved = repositories.flatMap((repository) => repository.paths.map((path) => named(repository, path.path)))
  const lines = planned.reduce((sum, entry) => sum + entry.shares.thread.lines + (brought ? entry.shares.uncertain.lines + entry.shares.unattributed.lines : 0), 0)
  const empty = { files: 0, lines: 0, paths: [] }
  const plan: MovePlan = {
    id: input.id,
    thread: input.thread,
    at: Date.now(),
    step: "writing",
    brought,
    repositories,
    outcome: {
      came: { files: moved.length, lines: moving ? lines : 0, paths: moved.slice(0, LISTED) },
      stayed: { others: shares.others, person: shares.person, uncertain: brought ? empty : shares.uncertain, unattributed: brought ? empty : shares.unattributed, kept: shares.kept ?? 0 },
      split: shares.split,
      brought,
      unstaged: repositories.flatMap((repository) => repository.index.filter((change) => change.unstaged).map((change) => named(repository, change.path))),
    },
  }
  if (shares.likely?.files) plan.outcome.likely = shares.likely
  // Stored even when nothing moves now, for "Bring these" afterwards.
  for (const repository of repositories) {
    const oids = new Set(repository.paths.concat(repository.bring).flatMap((path) => [path.base, path.before, path.thread, path.remaining]).flatMap((version) => (version ? [version.oid] : [])))
    await storeBlobs(git, repository.repoRoot, new Map([...oids].map((oid) => [oid, bytes.get(oid)!])))
  }
  input.stepped?.("stored")
  if (!moving) {
    input.log("nothing of the thread's to move", { thread: input.thread, stayed: shares.kept ?? 0, uncertain: plan.outcome.stayed.uncertain.files, unattributed: plan.outcome.stayed.unattributed.files, ms: Math.round(planMs) })
    plan.step = "done"
    return plan
  }
  for (const repository of repositories) {
    if (!repository.paths.length) continue
    repository.backup = `${BACKUP_REFS}${input.id}`
    await backUp(git, repository.repoRoot, repository.head, repository.backup, `Mako: the main checkout before moving Thread ${input.thread} to ${input.branch}`)
  }
  plan.outcome.backup = `${BACKUP_REFS}${input.id}`
  input.stepped?.("backed-up")
  await input.save(plan)
  input.stepped?.("saved")
  const writeStarted = performance.now()
  const writes = repositories.map((repository) => ({ ...forward(repository, repository.paths), index: repository.index.map((change) => ({ path: change.path, entry: change.to })) }))
  try {
    await applyWrites(git, ledger, writes, bytes, true, () => input.stepped?.("wrote"))
    input.stepped?.("written")
    const off = await landed(writes)
    if (off) throw new Error(off)
  } catch (error) {
    const left = await undo(git, ledger, plan, bytes, (repository) => repository.paths).catch((undoError: Error) => [`(the undo failed: ${undoError.message})`])
    await input.save(undefined)
    input.log("move rolled back", { thread: input.thread, reason: error instanceof Error ? error.message : String(error), left: left.join(", ").slice(0, 500), backup: plan.outcome.backup ?? "" })
    if (error instanceof MoveRefused) throw error
    throw new Error(`The move didn't finish, so Mako put both checkouts back as they were${left.length ? `, except ${left.join(", ")}, which changed since` : ""}. The main checkout's state before it is kept as ${plan.outcome.backup}. (${error instanceof Error ? error.message : String(error)})`, { cause: error })
  }
  plan.step = "done"
  await input.save(plan)
  input.stepped?.("done")
  input.log("moved", {
    thread: input.thread,
    repositories: repositories.length,
    files: plan.outcome.came.files,
    lines: plan.outcome.came.lines,
    stayedOthers: shares.kept ?? 0,
    uncertain: plan.outcome.stayed.uncertain.files,
    unattributed: plan.outcome.stayed.unattributed.files,
    split: plan.outcome.split.length,
    brought,
    planMs: Math.round(planMs),
    writeMs: Math.round(performance.now() - writeStarted),
    ms: Math.round(performance.now() - started),
  })
  return plan
}

/** One file a rewrite in place changes: its bytes now and after, null for no file. */
export interface InPlaceFile {
  /** Relative to its repository. */
  path: string
  before: Buffer | null
  /** Its permission bits now; a file put back gets 0644. */
  perm?: number
  after: Buffer | null
}

export interface InPlaceInput {
  git: Git
  ledger: Pick<MoveLedger, "mako"> | undefined
  /** A UUID: the plan's name and the backup's (`refs/mako/moves/<id>`). */
  id: string
  thread: string
  /** The folder the outcome names paths against. */
  project: string
  repositories: readonly { repoRoot: string; head: string; files: readonly InPlaceFile[] }[]
  /** The backup commit's message: what it was kept before. */
  message: string
  /** Keep the plan where a later start finds it; undefined once it needs no finishing. */
  save(plan: MovePlan | undefined): Promise<void>
  log: MoveInput["log"]
  /** Each step as it's reached, for a test that stops there. */
  stepped?: (step: string) => void
}

/**
 * Rewrite files of one checkout in place, all or nothing, with the move's
 * writer: every version is stored in the repository's objects, the
 * checkout's whole state (files and index) is kept under
 * `refs/mako/moves/<id>` for 14 days, the plan is saved, each file is
 * replaced by a rename after checking it still holds what was read, and
 * every file is read back. Anything off puts every file back as it was,
 * leaving one someone changed meanwhile as they left it. The plan is a
 * move's whose worktree side is the checkout's own "before" (nothing to
 * write there), so a host that dies mid-write finishes or undoes it with
 * `resumeMove`. The index is left as it is: a staged file reads as staged
 * with the rewrite unstaged, as an editor's change would.
 */
export async function rewriteInPlace(input: InPlaceInput): Promise<MovePlan> {
  const { git } = input
  const bytes = new Map<string, Buffer>()
  const repositories: RepositoryPlan[] = []
  for (const repository of input.repositories) {
    await pruneBackups(git, repository.repoRoot).catch(() => 0)
    const format = await objectFormat(git, repository.repoRoot)
    const version = (buffer: Buffer | null, perm: number | undefined): Version | null => {
      if (!buffer) return null
      const oid = blobId(buffer, format)
      bytes.set(oid, buffer)
      return { oid, perm: perm ?? 0o644 }
    }
    const paths = repository.files.map((file): MovePath => {
      const before = version(file.before, file.perm)
      return { path: file.path, how: "lines", base: before, before, thread: before, remaining: version(file.after, file.perm) }
    })
    repositories.push({ repoRoot: repository.repoRoot, worktree: repository.repoRoot, head: repository.head, format, backup: null, paths, index: [], bring: [] })
  }
  for (const repository of repositories) {
    const oids = new Set(repository.paths.flatMap((path) => [path.before, path.remaining]).flatMap((version) => (version ? [version.oid] : [])))
    await storeBlobs(git, repository.repoRoot, new Map([...oids].map((oid) => [oid, bytes.get(oid)!])))
  }
  input.stepped?.("stored")
  const backup = `${BACKUP_REFS}${input.id}`
  for (const repository of repositories) {
    if (!repository.paths.length) continue
    repository.backup = backup
    await backUp(git, repository.repoRoot, repository.head, backup, input.message)
  }
  input.stepped?.("backed-up")
  const named = repositories.flatMap((repository) => repository.paths.map((path) => relative(input.project, join(repository.repoRoot, path.path)) || path.path))
  const empty = { files: 0, lines: 0, paths: [] }
  const plan: MovePlan = {
    id: input.id,
    thread: input.thread,
    at: Date.now(),
    step: "writing",
    brought: false,
    repositories,
    outcome: {
      came: { files: named.length, lines: repositories.reduce((sum, repository) => sum + repository.paths.reduce((count, path) => count + changedLines(bytes, path.before, path.remaining), 0), 0), paths: named.slice(0, LISTED) },
      stayed: { others: empty, person: empty, uncertain: empty, unattributed: empty },
      split: [],
      brought: false,
      unstaged: [],
      backup,
    },
  }
  await input.save(plan)
  input.stepped?.("saved")
  const writes = repositories.map((repository) => ({ ...forward(repository, repository.paths), index: [] }))
  try {
    await applyWrites(git, input.ledger, writes, bytes, true, () => input.stepped?.("wrote"))
    input.stepped?.("written")
    const off = await landed(writes)
    if (off) throw new Error(off)
  } catch (error) {
    const left = await undo(git, input.ledger, plan, bytes, (repository) => repository.paths).catch((undoError: Error) => [`(the undo failed: ${undoError.message})`])
    await input.save(undefined)
    input.log("rewrite rolled back", { thread: input.thread, reason: error instanceof Error ? error.message : String(error), left: left.join(", ").slice(0, 500), backup })
    if (error instanceof MoveRefused) throw error
    throw new Error(`The change didn't finish, so Mako put every file back as it was${left.length ? `, except ${left.join(", ")}, which changed since` : ""}. The checkout's state before it is kept as ${backup}. (${error instanceof Error ? error.message : String(error)})`, { cause: error })
  }
  plan.step = "done"
  await input.save(undefined)
  input.stepped?.("done")
  return plan
}

/**
 * Finish a move cut short, from its saved plan: forward when every file on
 * both sides is as it was or as the plan wants, else back. Returns the plan,
 * done, or throws once it has rolled back.
 */
export async function resumeMove(git: Git, ledger: Pick<MoveLedger, "mako"> | undefined, plan: MovePlan, log: MoveInput["log"]): Promise<MovePlan> {
  if (plan.step === "done") return plan
  const bytes = new Map<string, Buffer>()
  for (const repository of plan.repositories) {
    const oids = repository.paths.flatMap((path) => [path.base, path.before, path.thread, path.remaining]).flatMap((version) => (version ? [version.oid] : []))
    for (const [oid, buffer] of await loadBlobs(git, repository.repoRoot, oids)) bytes.set(oid, buffer)
  }
  const writes = plan.repositories.map((repository) => ({ ...forward(repository, repository.paths), index: repository.index.map((change) => ({ path: change.path, entry: change.to })) }))
  let consistent = true
  for (const { plan: repository, worktree, main } of writes)
    for (const [folder, list] of [[repository.worktree, worktree], [repository.repoRoot, main]] as const)
      if ((await states(folder, list, repository.format)).includes("changed")) consistent = false
  if (consistent) {
    await applyWrites(git, ledger, writes, bytes, true)
    const off = await landed(writes)
    if (!off) {
      log("move resumed", { thread: plan.thread, files: plan.outcome.came.files })
      return { ...plan, step: "done" }
    }
  }
  const left = await undo(git, ledger, plan, bytes, (repository) => repository.paths)
  log("move cut short was rolled back", { thread: plan.thread, left: left.join(", ").slice(0, 500), backup: plan.outcome.backup ?? "" })
  throw new Error(`The move into the worktree was cut short, and a file changed since, so Mako put both checkouts back as they were${left.length ? `, except ${left.join(", ")}` : ""}. The main checkout's state before it is kept as ${plan.outcome.backup ?? "a backup ref"}.`)
}

/**
 * "Bring these" after a move: the changes that might be the Thread's and
 * those nobody can be named for follow it, from where this move left them.
 * A file either checkout changed since stays, and is named. The plan is
 * saved marked before the first write, so a start that finds it runs this
 * again: what landed reads as done, and the rest follows.
 */
export async function bringStayed(git: Git, ledger: MoveLedger | undefined, plan: MovePlan, project: string, log: MoveInput["log"], hooks: AdjustHooks = {}): Promise<{ plan: MovePlan; brought: number; came: string[]; left: string[] }> {
  if (plan.brought) return { plan, brought: 0, came: [], left: [] }
  const bytes = new Map<string, Buffer>()
  const writes = []
  for (const repository of plan.repositories) {
    const oids = repository.bring.flatMap((path) => [path.base, path.before, path.thread, path.remaining]).concat(repository.paths.flatMap((path) => [path.thread, path.remaining]))
    for (const [oid, buffer] of await loadBlobs(git, repository.repoRoot, oids.flatMap((version) => (version ? [version.oid] : [])))) bytes.set(oid, buffer)
    const moved = new Map(repository.paths.map((path) => [path.path, path]))
    const worktree: Write[] = []
    const main: Write[] = []
    // Each file from where the move left it; its index entry follows as a move's would.
    const steps: MovePath[] = []
    for (const path of repository.bring) {
      const after = moved.get(path.path)
      const [thread, remaining] = after ? [after.thread, after.remaining] : [path.base, path.before]
      if (thread?.oid !== path.thread?.oid) worktree.push({ path: path.path, from: thread, to: path.thread })
      if (remaining?.oid !== path.remaining?.oid) main.push({ path: path.path, from: remaining, to: path.remaining })
      steps.push({ ...path, before: remaining })
    }
    const index = (await indexChanges(git, repository.repoRoot, repository.head, steps)).map((change) => ({ path: change.path, entry: change.to }))
    writes.push({ plan: repository, worktree, main, index })
  }
  // A file changed on either side since stays as it is, on both.
  const left = new Set<string>()
  for (const entry of writes)
    for (const [folder, list] of [[entry.plan.worktree, entry.worktree], [entry.plan.repoRoot, entry.main]] as const) {
      const found = await states(folder, list, entry.plan.format)
      list.forEach((write, index) => {
        if (found[index] === "changed") left.add(`${entry.plan.repoRoot}\0${write.path}`)
      })
    }
  for (const entry of writes) {
    entry.worktree = entry.worktree.filter((write) => !left.has(`${entry.plan.repoRoot}\0${write.path}`))
    entry.main = entry.main.filter((write) => !left.has(`${entry.plan.repoRoot}\0${write.path}`))
    entry.index = entry.index.filter((change) => !left.has(`${entry.plan.repoRoot}\0${change.path}`))
  }
  // The main checkout as it is now is kept too, as the move's was.
  const backup = `${BACKUP_REFS}${plan.id}-brought`
  for (const entry of writes)
    if (entry.main.length) await backUpOnce(git, entry.plan.repoRoot, entry.plan.head, backup, `Mako: the main checkout before bringing what stayed to Thread ${plan.thread}`)
  await hooks.save?.({ ...plan, adjusting: { kind: "bring" } })
  hooks.stepped?.("bring-saved")
  await applyWrites(git, ledger, writes, bytes, false, () => hooks.stepped?.("bring-wrote"))
  const off = await landed(writes)
  if (off) throw new Error(`Bringing them didn't finish: ${off}.`)
  const relativeOf = (key: string) => {
    const [repoRoot = "", path = ""] = key.split("\0")
    return relative(project, join(repoRoot, path)) || path
  }
  const came = new Set(writes.flatMap((entry) => [...entry.worktree, ...entry.main].map((write) => `${entry.plan.repoRoot}\0${write.path}`)))
  const brought = came.size
  // A file the move already took, some of its lines, counts once.
  const added = writes.reduce((sum, entry) => {
    const moved = new Set(entry.plan.paths.map((path) => path.path))
    return sum + new Set([...entry.worktree, ...entry.main].map((write) => write.path).filter((path) => !moved.has(path))).size
  }, 0)
  const named = [...left].map(relativeOf)
  log("brought what stayed", { thread: plan.thread, files: brought, left: named.length })
  const empty = { files: 0, lines: 0, paths: [] }
  const outcome: MoveOutcome = {
    ...plan.outcome,
    came: { files: plan.outcome.came.files + added, paths: [...new Set([...plan.outcome.came.paths, ...[...came].map(relativeOf)])].sort().slice(0, LISTED), lines: plan.outcome.came.lines + plan.outcome.stayed.uncertain.lines + plan.outcome.stayed.unattributed.lines },
    stayed: { ...plan.outcome.stayed, uncertain: empty, unattributed: empty },
    brought: true,
  }
  return { plan: { ...plan, adjusting: undefined, brought: true, outcome }, brought, came: [...came].map(relativeOf).sort(), left: named }
}

/**
 * "Put back" after a move: each of `paths` (project-relative) that came
 * goes back as both checkouts had it before the move, the worktree to its
 * base and the main checkout to what it held. A file either checkout changed
 * since stays as it is on both, and is named. The plan forgets what went
 * back, so a later "Bring these" starts from where it is. Like "Bring
 * these", the plan is saved marked before the first write.
 */
export async function putBack(git: Git, ledger: MoveLedger | undefined, plan: MovePlan, project: string, paths: readonly string[], log: MoveInput["log"], hooks: AdjustHooks = {}): Promise<{ plan: MovePlan; returned: string[]; left: string[] }> {
  const wanted = new Set(paths)
  const named = (repository: RepositoryPlan, path: string) => relative(project, join(repository.repoRoot, path)) || path
  const bytes = new Map<string, Buffer>()
  const writes: { plan: RepositoryPlan; chosen: Omit<MovePath, "how">[]; worktree: Write[]; main: Write[]; index: { path: string; entry: string | null }[] }[] = []
  for (const repository of plan.repositories) {
    const brought = new Map(plan.brought ? repository.bring.map((path) => [path.path, path]) : [])
    const came = new Map(repository.paths.map((path) => [path.path, path]))
    for (const [path, entry] of brought) if (!came.has(path) && (entry.thread?.oid !== entry.base?.oid || entry.remaining?.oid !== entry.before?.oid)) came.set(path, entry)
    // Where each file is now (the move's sides, or what "Bring these" made them), and where it goes back to.
    const chosen = [...came.values()].filter((path) => wanted.has(named(repository, path.path))).map((path) => {
      const now = brought.get(path.path) ?? path
      return { path: path.path, base: path.base, before: path.before, thread: now.thread, remaining: now.remaining }
    })
    const oids = chosen.flatMap((path) => [path.base, path.before, path.thread, path.remaining])
    for (const [oid, buffer] of await loadBlobs(git, repository.repoRoot, oids.flatMap((version) => (version ? [version.oid] : [])))) bytes.set(oid, buffer)
    const staged = await stagedEntries(git, repository.repoRoot, chosen.map((path) => path.path))
    writes.push({
      plan: repository,
      chosen,
      worktree: chosen.filter((path) => path.thread?.oid !== path.base?.oid).map((path) => ({ path: path.path, from: path.thread, to: path.base })),
      main: chosen.filter((path) => path.remaining?.oid !== path.before?.oid).map((path) => ({ path: path.path, from: path.remaining, to: path.before })),
      // The move's own index change is undone; one the person made since is theirs.
      index: repository.index.filter((change) => chosen.some((path) => path.path === change.path) && (staged.get(change.path) ?? null) === change.to).map((change) => ({ path: change.path, entry: change.from })),
    })
  }
  const left = new Set<string>()
  for (const entry of writes)
    for (const [folder, list] of [[entry.plan.worktree, entry.worktree], [entry.plan.repoRoot, entry.main]] as const) {
      const found = await states(folder, list, entry.plan.format)
      list.forEach((write, index) => {
        if (found[index] === "changed") left.add(`${entry.plan.repoRoot}\0${write.path}`)
      })
    }
  const kept = (entry: { plan: RepositoryPlan }, path: string) => !left.has(`${entry.plan.repoRoot}\0${path}`)
  for (const entry of writes) {
    entry.chosen = entry.chosen.filter((path) => kept(entry, path.path))
    entry.worktree = entry.worktree.filter((write) => kept(entry, write.path))
    entry.main = entry.main.filter((write) => kept(entry, write.path))
    entry.index = entry.index.filter((change) => kept(entry, change.path))
  }
  const backup = `${BACKUP_REFS}${plan.id}-returned`
  for (const entry of writes)
    if (entry.main.length) await backUpOnce(git, entry.plan.repoRoot, entry.plan.head, backup, `Mako: the main checkout before putting back files Thread ${plan.thread} took`)
  if (writes.some((entry) => entry.chosen.length)) await hooks.save?.({ ...plan, adjusting: { kind: "put-back", paths: [...paths] } })
  hooks.stepped?.("put-back-saved")
  await applyWrites(git, ledger, writes, bytes, false, () => hooks.stepped?.("put-back-wrote"))
  const off = await landed(writes)
  if (off) throw new Error(`Putting them back didn't finish: ${off}.`)
  const returned = writes.flatMap((entry) => entry.chosen.map((path) => named(entry.plan, path.path))).sort()
  const gone = new Set(returned)
  const lines = writes.reduce((sum, entry) => sum + entry.chosen.reduce((count, path) => count + changedLines(bytes, path.base, path.thread), 0), 0)
  const repositories = writes.map((entry) => {
    const back = new Set(entry.chosen.map((path) => path.path))
    return { ...entry.plan, paths: entry.plan.paths.filter((path) => !back.has(path.path)), bring: entry.plan.bring.filter((path) => !back.has(path.path)), index: entry.plan.index.filter((change) => !back.has(change.path)) }
  })
  const without = (share: MoveShare, count: number): MoveShare => ({ files: Math.max(0, share.files - count), lines: share.lines, paths: share.paths.filter((path) => !gone.has(path)) })
  const likelyGone = plan.outcome.likely ? plan.outcome.likely.paths.filter((path) => gone.has(path)).length : 0
  const likely = plan.outcome.likely && without(plan.outcome.likely, likelyGone)
  const outcome: MoveOutcome = {
    ...plan.outcome,
    came: { ...without(plan.outcome.came, returned.length), lines: Math.max(0, plan.outcome.came.lines - lines) },
    likely: likely?.files ? likely : undefined,
    returned: [...new Set([...(plan.outcome.returned ?? []), ...returned])].sort(),
  }
  const changedSince = [...left].map((key) => {
    const [repoRoot = "", path = ""] = key.split("\0")
    return relative(project, join(repoRoot, path)) || path
  })
  log("put back", { thread: plan.thread, files: returned.length, left: changedSince.length })
  return { plan: { ...plan, adjusting: undefined, repositories, outcome }, returned, left: changedSince }
}

/** The index's own entries for `paths`, as `<mode> <oid>`. */
async function stagedEntries(git: Git, repoRoot: string, paths: readonly string[]): Promise<Map<string, string>> {
  if (!paths.length) return new Map()
  const listed = await git.run({ cwd: repoRoot, args: ["ls-files", "-s", "-z", "--", ...paths.map((path) => `:(literal)${path}`)], read: true })
  const out = new Map<string, string>()
  for (const record of listed.stdout.toString("utf8").split("\0")) {
    const tab = record.indexOf("\t")
    if (tab < 0) continue
    const [mode, oid, stage] = record.slice(0, tab).split(" ")
    if (stage === "0") out.set(record.slice(tab + 1), `${mode} ${oid}`)
  }
  return out
}

/** Lines added plus lines removed from one version to another; a binary file counts none. */
function changedLines(bytes: ReadonlyMap<string, Buffer>, from: Version | null, to: Version | null): number {
  const text = (version: Version | null) => {
    if (!version) return ""
    const buffer = bytes.get(version.oid)
    return buffer && !buffer.includes(0) ? buffer.toString("utf8") : undefined
  }
  const [a, b] = [text(from), text(to)]
  if (a === undefined || b === undefined) return 0
  return diffLines(splitLines(a), splitLines(b)).reduce((sum, hunk) => sum + hunk.added + hunk.removed, 0)
}

const files = (count: number) => `${count} ${count === 1 ? "file" : "files"}`
/** A share as an agent reads it: its count and, when short, its paths. */
const listed = (share: MoveShare) => `${files(share.files)}${share.paths.length && share.files <= 5 ? ` (${share.paths.join(", ")})` : ""}`

const some = (paths: readonly string[]) => `${paths.slice(0, 5).join(", ")}${paths.length > 5 ? `, and ${paths.length - 5} more` : ""}`

/** Files the user put back, for the agent in the worktree. */
export function returnedSentence(paths: readonly string[]): string {
  return `The user put ${files(paths.length)} back in the main checkout (${some(paths)}); they're not this Thread's, so this worktree has ${paths.length === 1 ? "it" : "them"} as the branch does. Leave ${paths.length === 1 ? "it" : "them"} out of this worktree unless the user asks.`
}

/** Files "Bring these" brought, for the agent in the worktree. */
export function broughtSentence(paths: readonly string[]): string {
  return `At the user's request, Mako brought ${files(paths.length)} the move had left in the main checkout into this worktree (${some(paths)}). Mako couldn't tell whether ${paths.length === 1 ? "it was" : "they were"} this Thread's work, so read ${paths.length === 1 ? "it" : "them"} before building on ${paths.length === 1 ? "it" : "them"}.`
}

/** What a move did, in sentences for the agent that goes on in the worktree. */
export function outcomeSentences(outcome: MoveOutcome): string[] {
  const out: string[] = []
  const { stayed } = outcome
  out.push(outcome.came.files
    ? `This Thread's uncommitted changes came with you: ${listed(outcome.came)}${outcome.came.lines ? `, ${outcome.came.lines} changed lines` : ""}${outcome.brought ? ", with those Mako couldn't attribute" : ""}.`
    : "None of the main checkout's uncommitted changes were this Thread's, so none came.")
  if (outcome.likely?.files)
    out.push(`Of these, Mako took ${listed(outcome.likely)} on timing alone: only this Thread's work was running when they changed. The user can put them back from the app.`)
  if (outcome.returned?.length) out.push(returnedSentence(outcome.returned))
  const others = [stayed.others.files ? `${files(stayed.others.files)} other Threads changed` : "", stayed.person.files ? `${files(stayed.person.files)} the user changed` : ""].filter(Boolean)
  if (others.length) out.push(`Their changes stayed in the main checkout: ${others.join(", ")}.`)
  const unsure = [stayed.uncertain.files ? `${listed(stayed.uncertain)} with lines that might be this Thread's` : "", stayed.unattributed.files ? `${listed(stayed.unattributed)} changed before Mako tracked the checkout, so nobody is named for them` : ""].filter(Boolean)
  if (unsure.length) out.push(`Also stayed: ${unsure.join("; ")}. The user can bring these from the app; don't copy them yourself.`)
  for (const hunk of outcome.split.slice(0, 5))
    out.push(`A hunk in ${hunk.path} couldn't be split by line, so it ${hunk.to === "thread" ? "came whole, since this Thread last wrote most of it" : "stayed whole, since others last wrote most of it"}.`)
  if (outcome.unstaged.length) out.push(`Staged in part before, now unstaged in the main checkout: ${outcome.unstaged.slice(0, 5).join(", ")}.`)
  return out
}

/**
 * How the changes in `roots`, the repositories of a project folder, divide
 * for `thread`, before any move. Without the journal nobody is named, so
 * every changed file is unattributed.
 */
export async function previewShares(git: Git, ledger: MoveLedger | undefined, project: string, roots: readonly string[], thread: string): Promise<MoveShares> {
  if (ledger) {
    const found: CheckoutShares[] = []
    for (const root of roots) await ledger.readBack?.(root, READ_BACK_MS)
    for (const root of roots) found.push(ledger.shares(root, thread))
    return moveShares(project, found)
  }
  const paths = (await Promise.all(roots.map(async (root) => (await everything(git, root)).map((path) => join(root, path))))).flat()
  const none = (): Share => ({ files: [], lines: 0 })
  return moveShares(project, [{ thread: none(), likely: none(), others: none(), person: none(), uncertain: none(), unattributed: { files: paths, lines: 0 } }])
}
