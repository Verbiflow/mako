import { createHash, randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import { existsSync } from "node:fs"
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Git, RunOptions } from "@mako/git"
import { ThreadFileHistorySchema, type ThreadFileHistory } from "@mako/protocol"
import {
  MOVE_CHECKPOINT_MAX_BYTES, MOVE_OUTSIDE_BYTES, MOVE_OUTSIDE_FILE_BYTES, MoveCarrySchema,
  type MoveCarry, type MoveCarryRef, type MoveCarryRepository, type MoveLeft, type MoveOutsideFile,
} from "@mako/protocol/moves"

/**
 * A move's carry (`MoveCarrySchema`): what a Thread takes besides its checkout, in one Git bundle named by its SHA-256.
 * Its one commit, `refs/mako/carry`, holds the manifest (`carry.json`), the Thread's file history (`history.json`) and
 * each file outside the Thread's folder at `outside/<absolute path>`. Capture writes nothing outside the folder the
 * caller gives it, and the commit carries a fixed author and date, so the same carry makes the same bundle, byte for
 * byte. Opened where it lands, the manifest is read first; nothing is written anywhere until the caller places it.
 *
 * Which outside paths a Thread may carry is one rule on both sides (`carriable`): under the person's home folder (the
 * first two parts of the Thread's folder, which a machine makes at the same path) or under `/tmp`, never inside the
 * Thread's folder, never in Mako's own data, never a Git folder. A Mac's `/private/tmp` is `/tmp` on the wire.
 */

const REF = "refs/mako/carry"
const MANIFEST = "carry.json"
const HISTORY = "history.json"
const OUTSIDE = "outside"

/** The carry's commit is Mako's, at a fixed moment, so the same carry makes the same commit. */
const FIXED = {
  GIT_AUTHOR_NAME: "Mako",
  GIT_AUTHOR_EMAIL: "mako@localhost",
  GIT_AUTHOR_DATE: "@0 +0000",
  GIT_COMMITTER_NAME: "Mako",
  GIT_COMMITTER_EMAIL: "mako@localhost",
  GIT_COMMITTER_DATE: "@0 +0000",
}
const TIMEOUT_MS = 5 * 60_000

async function run(git: Git, options: RunOptions): Promise<Buffer> {
  const result = await git.run({ timeoutMs: TIMEOUT_MS, maxBytes: MOVE_OUTSIDE_FILE_BYTES + 1024, ...options, args: ["-c", "core.fsmonitor=false", ...options.args] })
  if (result.truncated) throw new Error(`git ${options.args[0] ?? ""} wrote more than it may`)
  return result.stdout
}
const text = async (git: Git, options: RunOptions) => (await run(git, options)).toString("utf8").trim()

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

/** A path as the wire spells it: the Mac's `/private/tmp` is `/tmp`, as on Linux. */
export function carriedPath(path: string): string {
  return path === "/private/tmp" || path.startsWith("/private/tmp/") ? path.slice("/private".length) : path
}

/** The person's home folder a Thread's folder is in, as a machine makes it: `/Users/<name>` or `/home/<name>`. */
export function homeOf(folder: string): string | undefined {
  const match = /^\/(Users|home)\/[^/]+/.exec(folder)
  return match?.[0]
}

const inside = (folder: string, path: string) => path === folder || path.startsWith(`${folder}/`)

/**
 * Whether a path outside the Thread's folder can go with it, or why not: one the machine holds at the same path, under
 * the person's home or `/tmp`, that isn't Mako's own, a Git folder's, or inside the Thread's folder (its checkout).
 */
export function carriable(path: string, folder: string): MoveLeft["why"] | undefined {
  const at = carriedPath(path)
  const home = homeOf(folder)
  if (inside(folder, at)) return "folder"
  if (at.split("/").includes(".git")) return "elsewhere"
  if (home && (inside(join(home, ".mako"), at))) return "elsewhere"
  if (!(home && inside(home, at)) && !inside("/tmp", at)) return "elsewhere"
  return undefined
}

/** A path the Thread used outside its folder, as the footprint has it, to carry if it can. */
export type OutsideCandidate = { path: string; access: "read" | "write"; secret?: boolean }

/** What a carry holds before it's sent: its manifest, and where its bundle is. */
export type CapturedCarry = { ref: MoveCarryRef; file: string; carry: MoveCarry }

/** A file outside the folder, read for the carry: its manifest entry and its bytes (a symlink's are its target). */
type ReadOutside = { entry: MoveOutsideFile; bytes: Buffer }

/** Reads each candidate that can go, deciding what's left and why; at most the per-file and whole limits. */
export async function readOutside(candidates: readonly OutsideCandidate[], folder: string): Promise<{ read: ReadOutside[]; left: MoveLeft[] }> {
  const read: ReadOutside[] = []
  const left: MoveLeft[] = []
  const seen = new Map<string, OutsideCandidate>()
  for (const candidate of candidates) {
    const at = carriedPath(candidate.path)
    const known = seen.get(at)
    // A path both read and written goes as written, and one ever marked secret stays secret.
    seen.set(at, { path: at, access: known?.access === "write" || candidate.access === "write" ? "write" : "read", secret: Boolean(known?.secret || candidate.secret) })
  }
  let total = 0
  for (const candidate of [...seen.values()].sort((left, right) => left.path.localeCompare(right.path))) {
    if (candidate.secret) {
      left.push({ path: candidate.path, why: "secret" })
      continue
    }
    const why = carriable(candidate.path, folder)
    if (why) {
      // Its own checkout's files are the checkpoint's, not left behind.
      if (why !== "folder") left.push({ path: candidate.path, why })
      continue
    }
    const info = await lstat(candidate.path).catch(() => undefined)
    // Gone since it was used: nothing to carry, and nothing to say.
    if (!info) continue
    if (!info.isFile() && !info.isSymbolicLink()) {
      left.push({ path: candidate.path, why: "unreadable" })
      continue
    }
    if (info.size > MOVE_OUTSIDE_FILE_BYTES || total + info.size > MOVE_OUTSIDE_BYTES) {
      left.push({ path: candidate.path, why: "too-large" })
      continue
    }
    const bytes = await (info.isSymbolicLink() ? readlink(candidate.path).then((target) => Buffer.from(target)) : readFile(candidate.path)).catch(() => undefined)
    if (!bytes || bytes.length > MOVE_OUTSIDE_FILE_BYTES) {
      left.push({ path: candidate.path, why: bytes ? "too-large" : "unreadable" })
      continue
    }
    total += bytes.length
    const kind: MoveOutsideFile["kind"] = info.isSymbolicLink() ? "symlink" : info.mode & 0o111 ? "executable" : "file"
    read.push({ entry: { path: candidate.path, kind, sha256: sha256(bytes), bytes: bytes.length, access: candidate.access }, bytes })
  }
  return { read, left }
}

const GIT_MODE = { file: "100644", executable: "100755", symlink: "120000" } satisfies Record<MoveOutsideFile["kind"], string>

/**
 * Captures a carry into `<scratch>/carry.bundle`: the manifest, the history and every outside file already read
 * (`readOutside`). `scratch` is a directory the caller owns and removes. Refused past the checkpoints' limit.
 */
export async function captureCarry(
  git: Git,
  input: { folder: string; repositories: MoveCarryRepository[]; outside: readonly ReadOutside[]; left: readonly MoveLeft[]; gone?: readonly string[]; history?: ThreadFileHistory },
  scratch: string,
): Promise<CapturedCarry> {
  const carry = MoveCarrySchema.parse({
    version: 1,
    folder: input.folder,
    repositories: input.repositories,
    outside: input.outside.map((each) => each.entry),
    gone: [...input.gone ?? []],
    left: [...input.left],
    history: input.history !== undefined,
  })
  const work = await mkdtemp(join(scratch, "carry-"))
  try {
    const repository = join(work, "carry.git")
    await run(git, { cwd: work, args: ["init", "--bare", "--quiet", "--template=", repository] })
    const at = { ...FIXED, GIT_DIR: repository, GIT_INDEX_FILE: join(work, "index") }
    const blob = async (bytes: Buffer | string) => text(git, { cwd: work, args: ["hash-object", "-w", "--no-filters", "--stdin"], input: bytes, env: at })
    const entries: string[] = []
    entries.push(`100644 ${await blob(`${JSON.stringify(carry, null, 1)}\n`)}\t${MANIFEST}`)
    if (input.history) entries.push(`100644 ${await blob(JSON.stringify(input.history))}\t${HISTORY}`)
    for (const { entry, bytes } of input.outside) entries.push(`${GIT_MODE[entry.kind]} ${await blob(bytes)}\t${OUTSIDE}${entry.path}`)
    await run(git, { cwd: work, args: ["update-index", "--add", "--index-info"], input: `${entries.join("\n")}\n`, env: at })
    const tree = await text(git, { cwd: work, args: ["write-tree"], env: at })
    const commit = await text(git, { cwd: work, args: ["commit-tree", tree, "-m", "carry"], env: at })
    await run(git, { cwd: work, args: ["update-ref", REF, commit], env: at })
    const file = join(scratch, "carry.bundle")
    await run(git, { cwd: work, args: ["bundle", "create", "--quiet", file, REF], env: at })
    const bytes = (await stat(file)).size
    if (bytes > MOVE_CHECKPOINT_MAX_BYTES) throw new Error(`What this Thread carries comes to ${Math.ceil(bytes / 1024 / 1024)} MB, past what a move takes.`)
    return { ref: { sha256: await fileSha256(file), bytes }, file, carry }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** A carry where it landed: its manifest, its history, and each outside file's bytes read as they're placed. */
export type OpenedCarry = {
  carry: MoveCarry
  history: ThreadFileHistory | undefined
  bytes(path: string): Promise<Buffer>
}

/**
 * Opens the carry bundle at `file`, checked against `ref`, into a private repository under `scratch` (which the caller
 * owns and removes), and reads its manifest and history.
 */
export async function openCarry(git: Git, file: string, ref: MoveCarryRef, scratch: string): Promise<OpenedCarry> {
  if ((await fileSha256(file)) !== ref.sha256) throw new Error("The carry's bytes aren't the ones it names.")
  const repository = await mkdtemp(join(scratch, "opened-"))
  await run(git, { cwd: repository, args: ["init", "--bare", "--quiet", "--template=", repository] })
  await run(git, { cwd: repository, args: ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", file, `${REF}:${REF}`] })
  const show = (path: string) => run(git, { cwd: repository, args: ["cat-file", "blob", `${REF}:${path}`], maxBytes: MOVE_CHECKPOINT_MAX_BYTES })
  const carry = MoveCarrySchema.parse(JSON.parse((await show(MANIFEST)).toString("utf8")))
  const history = carry.history ? ThreadFileHistorySchema.parse(JSON.parse((await show(HISTORY)).toString("utf8"))) : undefined
  return { carry, history, bytes: (path) => show(`${OUTSIDE}${path}`) }
}

/** What a file at `path` holds now, as the carry names files: its SHA-256, or undefined when there's none. */
export async function currentSha256(path: string): Promise<string | undefined> {
  const info = await lstat(path).catch(() => undefined)
  if (!info) return undefined
  if (info.isSymbolicLink()) return sha256(Buffer.from(await readlink(path)))
  if (!info.isFile()) return "not-a-file"
  return fileSha256(path)
}

/** Writes a carried file at `path`, whole or not at all: beside it, then renamed in. */
export async function writeCarried(path: string, kind: MoveOutsideFile["kind"], bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const beside = `${path}.mako-${randomBytes(4).toString("hex")}`
  try {
    if (kind === "symlink") await symlink(bytes.toString("utf8"), beside)
    else {
      await writeFile(beside, bytes)
      await chmod(beside, kind === "executable" ? 0o755 : 0o644)
    }
    await rename(beside, path)
  } catch (error) {
    await unlink(beside).catch(() => undefined)
    throw error
  }
}

/**
 * Places a carry's outside files where it lands: each at its own path, as the side it left had it. Answers what it
 * placed and what it couldn't (a path this machine can't make), never failing the move for one.
 */
export async function placeOutside(opened: OpenedCarry): Promise<{ placed: string[]; failed: Array<{ path: string; error: string }> }> {
  const placed: string[] = []
  const failed: Array<{ path: string; error: string }> = []
  for (const entry of opened.carry.outside) {
    try {
      if ((await currentSha256(entry.path)) !== entry.sha256) await writeCarried(entry.path, entry.kind, await opened.bytes(entry.path))
      placed.push(entry.path)
    } catch (error) {
      failed.push({ path: entry.path, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { placed, failed }
}

/**
 * What the way back does with each outside file the cloud sent: `place` when this side's copy is the one that left
 * (`left`: its SHA-256 then, or undefined when there was none), `remove` when the cloud removed one this side still
 * has unchanged, `same` when this side already has the cloud's, `wait` when this side changed it since (the person's
 * newer file is never written over: the cloud's waits beside, to be put in place).
 */
export type OutsideReturn = { path: string; action: "place" | "remove" | "same" | "wait"; entry?: MoveOutsideFile }

export async function planOutsideReturn(carry: MoveCarry, left: ReadonlyMap<string, string>): Promise<OutsideReturn[]> {
  const plan: OutsideReturn[] = []
  for (const entry of carry.outside) {
    const here = await currentSha256(entry.path)
    if (here === entry.sha256) plan.push({ path: entry.path, action: "same", entry })
    else plan.push({ path: entry.path, action: here === left.get(entry.path) ? "place" : "wait", entry })
  }
  for (const path of carry.gone) {
    const here = await currentSha256(path)
    if (here === undefined) continue
    plan.push({ path, action: here === left.get(path) ? "remove" : "wait" })
  }
  return plan
}

/** What the way back did with the outside files: put in place, removed, or kept apart because the person changed them. */
export type OutsideReturned = { placed: string[]; removed: string[]; waiting: string[] }

/**
 * Carries out the way back's plan for outside files: placed or removed where this side's copy is the one that left,
 * and kept under `waiting` (at `<waiting>/<absolute path>`) where the person changed it since.
 */
export async function returnOutside(opened: OpenedCarry, plan: readonly OutsideReturn[], waiting: string): Promise<OutsideReturned> {
  const done: OutsideReturned = { placed: [], removed: [], waiting: [] }
  for (const step of plan) {
    if (step.action === "same") continue
    if (step.action === "remove") {
      await rm(step.path, { force: true })
      done.removed.push(step.path)
      continue
    }
    const entry = step.entry
    if (!entry) {
      // Removed in the cloud, changed here: what's here stays, and nothing waits.
      done.waiting.push(step.path)
      continue
    }
    const bytes = await opened.bytes(entry.path)
    if (step.action === "place") {
      await writeCarried(entry.path, entry.kind, bytes)
      done.placed.push(entry.path)
    } else {
      await writeCarried(join(waiting, entry.path), entry.kind, bytes)
      done.waiting.push(entry.path)
    }
  }
  return done
}

/**
 * Clones a project's other repository at `path` on a machine, as its agent clones the Thread's first: its blobs fetched
 * as they're read, beside its place and renamed in, so `path` holds a whole clone or nothing. One already there (a host
 * that restarted) is kept. Never asks for a credential: a repository the machine can't read fails at once.
 */
export async function cloneRepository(git: Git, repository: { path: string; url: string; branch?: string }): Promise<void> {
  if (existsSync(join(repository.path, ".git"))) return
  await mkdir(dirname(repository.path), { recursive: true })
  const beside = `${repository.path}.cloning-${randomBytes(4).toString("hex")}`
  try {
    const result = await git.run({
      cwd: dirname(repository.path),
      args: ["clone", "--quiet", "--filter=blob:none", ...repository.branch ? ["--branch", repository.branch] : [], "--", repository.url, beside],
      env: { GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: 10 * 60_000,
      codes: [128],
    })
    if (result.code !== 0) throw new Error(result.stderr.trim().split("\n").at(-1) ?? "git clone failed")
    await rename(beside, repository.path)
  } finally {
    await rm(beside, { recursive: true, force: true })
  }
}
