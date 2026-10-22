import { createHash } from "node:crypto"
import { createReadStream, existsSync } from "node:fs"
import { copyFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Git, RunOptions } from "@mako/git"
import { MOVE_CHECKPOINT_MAX_BYTES, MoveCheckpointSchema, type MoveCheckpoint } from "@mako/protocol/moves"

/**
 * A checkout as it stands, carried to another computer: its commits that the repository's remote doesn't have, what's
 * staged, and every file in the folder that Git doesn't ignore, untracked ones included, as one Git bundle. Applied to
 * a clone of the same repository, the clone reads back the same: the same HEAD on the same branch, the same index, the
 * same files. Ignored files (installs, builds, `.env` files) are never carried; the recipe makes what a checkout needs.
 *
 * Capture writes nothing into the repository: its objects go to a private object store beside the bundle, and its refs
 * live in a private bare repository that borrows the repository's objects. Capture's commits carry a fixed author and
 * date, so a checkout that hasn't changed makes the same bundle, byte for byte, and the same hash.
 */
export class MoveCheckpointError extends Error {
  readonly kind: "no-commits" | "conflicts" | "too-large" | "missing-base" | "mismatch"
  constructor(kind: MoveCheckpointError["kind"], message: string) {
    super(message)
    this.name = "MoveCheckpointError"
    this.kind = kind
  }
}

const REFS = { head: "refs/mako/head", index: "refs/mako/index", work: "refs/mako/work" } as const
const ARRIVED = "refs/mako/arrived"

/** Capture's commits are Mako's, at a fixed moment, so the same checkout makes the same commits. */
const FIXED = {
  GIT_AUTHOR_NAME: "Mako",
  GIT_AUTHOR_EMAIL: "mako@localhost",
  GIT_AUTHOR_DATE: "@0 +0000",
  GIT_COMMITTER_NAME: "Mako",
  GIT_COMMITTER_EMAIL: "mako@localhost",
  GIT_COMMITTER_DATE: "@0 +0000",
}

const TIMEOUT_MS = 5 * 60_000

async function run(git: Git, options: RunOptions): Promise<string> {
  const result = await git.run({ timeoutMs: TIMEOUT_MS, maxBytes: 16 * 1024 * 1024, ...options, args: ["-c", "core.fsmonitor=false", ...options.args] })
  if (result.truncated) throw new Error(`git ${options.args[0] ?? ""} wrote more than 16 MB`)
  return result.stdout.toString("utf8").trim()
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

/**
 * Captures `checkout` into `<folder>/checkpoint.bundle`, `folder` being a directory the caller owns and removes. A
 * repository with no commits, or an index with conflicts, is refused with the reason; so is a bundle past the limit.
 */
export async function captureMoveCheckpoint(git: Git, checkout: string, folder: string, maxBytes = MOVE_CHECKPOINT_MAX_BYTES): Promise<{ checkpoint: MoveCheckpoint; file: string }> {
  const head = await run(git, { cwd: checkout, args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], codes: [0, 1] })
  if (!head) throw new MoveCheckpointError("no-commits", "This checkout has no commits yet, so there's nothing to start a clone from.")
  const branch = await run(git, { cwd: checkout, args: ["symbolic-ref", "--short", "--quiet", "HEAD"], codes: [0, 1] })
  const [index = "", objects = "", format = ""] = (await run(git, { cwd: checkout, args: ["rev-parse", "--path-format=absolute", "--git-path", "index", "--git-path", "objects", "--show-object-format"] })).split("\n")
  const scratch = await mkdtemp(join(folder, "capture-"))
  try {
    // A private repository: its objects are capture's own, and it reads the checkout's through an alternate.
    const carry = join(scratch, "carry.git")
    await run(git, { cwd: scratch, args: ["init", "--bare", "--quiet", "--template=", `--object-format=${format}`, carry] })
    await writeFile(join(carry, "objects", "info", "alternates"), `${objects}\n`)
    const env = { ...FIXED, GIT_OBJECT_DIRECTORY: join(carry, "objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: objects }
    const tree = async (indexFile: string, stage: boolean): Promise<string> => {
      const at = { ...env, GIT_INDEX_FILE: indexFile }
      // A checkout with no index yet reads as HEAD.
      if (existsSync(index)) await copyFile(index, indexFile)
      else await run(git, { cwd: checkout, args: ["read-tree", head], env: at })
      if (stage) await run(git, { cwd: checkout, args: ["add", "--all", "--", "."], env: at })
      const written = await git.run({ cwd: checkout, args: ["-c", "core.fsmonitor=false", "write-tree"], env: at, timeoutMs: TIMEOUT_MS, codes: [0, 128] })
      if (written.code !== 0) throw new MoveCheckpointError("conflicts", "This checkout has conflicts to resolve first: Git can't record an index with unmerged files.")
      return written.stdout.toString("utf8").trim()
    }
    const commit = (of: string, message: string) => run(git, { cwd: carry, args: ["commit-tree", of, "-p", head, "-m", message], env })
    const indexCommit = await commit(await tree(join(scratch, "index"), false), "index")
    const workCommit = await commit(await tree(join(scratch, "work"), true), "work")
    for (const [ref, value] of [[REFS.head, head], [REFS.index, indexCommit], [REFS.work, workCommit]] as const)
      await run(git, { cwd: carry, args: ["update-ref", ref, value], env })
    // What the remote has is left out: the other end clones it from there.
    const remote = (await run(git, { cwd: checkout, args: ["for-each-ref", "--format=%(objectname)", "refs/remotes"] })).split("\n").filter(Boolean)
    const file = join(folder, "checkpoint.bundle")
    const revisions = [REFS.head, REFS.index, REFS.work, ...[...new Set(remote)].map((tip) => `^${tip}`)].join("\n") + "\n"
    await run(git, { cwd: carry, args: ["bundle", "create", "--quiet", file, "--stdin"], input: revisions, env })
    const bytes = (await stat(file)).size
    if (bytes > maxBytes) {
      await rm(file, { force: true })
      throw new MoveCheckpointError("too-large", `This checkout's changes come to ${Math.ceil(bytes / 1024 / 1024)} MB, past the ${Math.floor(maxBytes / 1024 / 1024)} MB a move carries. Files Git doesn't ignore count too: ignore build output, or commit and push what's large.`)
    }
    const read: MoveCheckpoint = { version: 1, sha256: await fileSha256(file), bytes, head, index: indexCommit, work: workCommit }
    if (branch) read.branch = branch
    const checkpoint = MoveCheckpointSchema.parse(read)
    return { checkpoint, file }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * Applies a checkpoint to `checkout`, a clean clone of the same repository: HEAD, the branch, the index and the files
 * become the checkpoint's, then are read back. A bundle whose base the clone lacks (the remote lost a commit the
 * checkout had) is refused before anything changes; one that reads back otherwise throws `mismatch`.
 */
export async function applyMoveCheckpoint(git: Git, checkout: string, file: string, checkpoint: MoveCheckpoint): Promise<void> {
  if ((await fileSha256(file)) !== checkpoint.sha256) throw new MoveCheckpointError("mismatch", "The checkpoint's bytes aren't the ones it names.")
  const verified = await git.run({ cwd: checkout, args: ["bundle", "verify", "--quiet", file], codes: [0, 1], timeoutMs: TIMEOUT_MS })
  if (verified.code !== 0) throw new MoveCheckpointError("missing-base", `This clone lacks a commit the checkpoint builds on: ${verified.stderr.trim().split("\n").at(-1) ?? "Git refused the bundle"}`)
  await run(git, { cwd: checkout, args: ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", file, `refs/mako/*:${ARRIVED}/*`] })
  try {
    await run(git, { cwd: checkout, args: checkpoint.branch ? ["checkout", "--quiet", "-B", checkpoint.branch, checkpoint.head] : ["checkout", "--quiet", "--detach", checkpoint.head] })
    // The files, then the index: what's staged stays staged, what isn't stays a change, untracked files stay untracked.
    await run(git, { cwd: checkout, args: ["read-tree", "-u", "--reset", checkpoint.work] })
    await run(git, { cwd: checkout, args: ["read-tree", checkpoint.index] })
  } finally {
    for (const ref of Object.keys(REFS)) await run(git, { cwd: checkout, args: ["update-ref", "-d", `${ARRIVED}/${ref}`] }).catch(() => undefined)
  }
  await verifyMoveCheckpoint(git, checkout, checkpoint)
}

/** Whether `checkout` reads as the checkpoint: HEAD, the index's tree and the files' tree. Throws `mismatch` if not. */
export async function verifyMoveCheckpoint(git: Git, checkout: string, checkpoint: MoveCheckpoint): Promise<void> {
  const head = await run(git, { cwd: checkout, args: ["rev-parse", "HEAD"] })
  const [indexTree, workTree] = (await run(git, { cwd: checkout, args: ["rev-parse", `${checkpoint.index}^{tree}`, `${checkpoint.work}^{tree}`] })).split("\n")
  const index = await run(git, { cwd: checkout, args: ["write-tree"] })
  const scratch = await mkdtemp(join(tmpdir(), "mako-verify-"))
  let files: string
  try {
    const at = { GIT_INDEX_FILE: join(scratch, "index") }
    await run(git, { cwd: checkout, args: ["read-tree", "HEAD"], env: at })
    await run(git, { cwd: checkout, args: ["add", "--all", "--", "."], env: at })
    files = await run(git, { cwd: checkout, args: ["write-tree"], env: at })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  const branch = await run(git, { cwd: checkout, args: ["symbolic-ref", "--short", "--quiet", "HEAD"], codes: [0, 1] })
  const off = [
    head !== checkpoint.head && "HEAD",
    (branch || undefined) !== checkpoint.branch && "the branch",
    index !== indexTree && "the index",
    files !== workTree && "the files",
  ].filter(Boolean)
  if (off.length) throw new MoveCheckpointError("mismatch", `The checkout doesn't read as the checkpoint: ${off.join(", ")} differ.`)
}
