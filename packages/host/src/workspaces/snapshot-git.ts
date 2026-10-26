import { createReadStream } from "node:fs"
import { lstat, readFile, readdir, rm } from "node:fs/promises"
import { delimiter, join } from "node:path"
import { z } from "zod"
import type { Git } from "@mako/git"

export interface SnapshotObjects {
  write?: string
  read?: string[]
}
const CaptureOwnerSchema = z.object({
  owner: z.literal("mako-checkpoint"),
  scope: z.string(),
  pid: z.number().int().positive(),
  state: z.enum(["preparing", "committed"]).default("preparing"),
})
export async function reclaimSnapshotOrphans(
  root: string,
  scope: string,
  known: ReadonlySet<string>
): Promise<number> {
  let retainedBytes = 0
  for (const id of await readdir(root)) {
    if (known.has(id) || !z.string().uuid().safeParse(id).success) continue
    const directory = join(root, id)
    const marker = join(directory, "capture-owner.json")
    let owner: z.infer<typeof CaptureOwnerSchema>
    try {
      const info = await lstat(marker)
      if (!info.isFile() || info.size > 8192)
        throw new Error("Invalid checkpoint ownership record")
      owner = CaptureOwnerSchema.parse(
        JSON.parse(await readFile(marker, "utf8"))
      )
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        continue
      throw error
    }
    if (owner.scope !== scope) continue
    if (owner.state === "committed") {
      retainedBytes += await snapshotPayloadBytes(directory)
      continue
    }
    try {
      process.kill(owner.pid, 0)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") {
        await rm(directory, { recursive: true, force: true })
        continue
      }
      throw error
    }
    retainedBytes += await snapshotPayloadBytes(directory)
  }
  return retainedBytes
}
/** Snapshot commits are Mako's; a private index and object store keep them out of the repository's own. */
type SnapshotEnvironment = {
  GIT_AUTHOR_NAME: string
  GIT_AUTHOR_EMAIL: string
  GIT_COMMITTER_NAME: string
  GIT_COMMITTER_EMAIL: string
  GIT_INDEX_FILE?: string
  GIT_OBJECT_DIRECTORY?: string
  GIT_ALTERNATE_OBJECT_DIRECTORIES?: string
}

function environment(
  index?: string,
  objects?: SnapshotObjects
): SnapshotEnvironment {
  return {
    GIT_AUTHOR_NAME: "Mako",
    GIT_AUTHOR_EMAIL: "mako@localhost",
    GIT_COMMITTER_NAME: "Mako",
    GIT_COMMITTER_EMAIL: "mako@localhost",
    GIT_INDEX_FILE: index || undefined,
    GIT_OBJECT_DIRECTORY: objects?.write || undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: objects?.read?.length
      ? objects.read.map((path) => JSON.stringify(path)).join(delimiter)
      : undefined,
  }
}
/** What one Git command of a checkpoint may print: a listing of every file of a large repository fits. */
export const SNAPSHOT_OUTPUT_BYTES = 64 * 1024 * 1024

export async function snapshotGit(
  git: Git,
  cwd: string,
  args: string[],
  index?: string,
  input?: string,
  objects?: SnapshotObjects
): Promise<string> {
  const result = await git.run({
    cwd,
    args: ["-c", "core.fsmonitor=false", ...args],
    read: true,
    env: environment(index, objects),
    input,
    maxBytes: SNAPSHOT_OUTPUT_BYTES,
    timeoutMs: 30_000,
  })
  if (result.truncated) throw new Error(`git ${args[0] ?? ""} wrote more than 64 MB for a checkpoint`)
  return result.stdout.toString("utf8")
}
export async function privateSnapshotObjects(
  git: Git,
  cwd: string,
  directory: string
): Promise<SnapshotObjects> {
  const format = (
    await snapshotGit(git,cwd, ["rev-parse", "--show-object-format"])
  ).trim()
  const source = (
    await snapshotGit(git,cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ])
  ).trim()
  await snapshotGit(git,cwd, [
    "init",
    "--bare",
    "--quiet",
    "--template=",
    `--object-format=${format}`,
    join(directory, "git"),
  ])
  return { write: join(directory, "git", "objects"), read: [source] }
}
/**
 * Pack what a checkpoint commit reaches into its private store, leaving out
 * what `base` (the commit checked out, which the repository keeps while it is
 * HEAD) holds already, by its tree, since no checkpoint descends from it: a checkpoint of a large repository keeps only what
 * the turn's files and staging add. A rewind is refused once HEAD moves, so
 * no restore needs what the base held.
 */
export async function sealSnapshotObjects(
  git: Git,
  cwd: string,
  directory: string,
  commit: string,
  objects: SnapshotObjects,
  limit: number,
  base?: string
): Promise<void> {
  const ids = await snapshotGit(git,
    cwd,
    ["rev-list", "--objects", "--no-object-names", commit, ...(base ? ["--not", `${base}^{tree}`] : [])],
    undefined,
    undefined,
    objects
  )
  const sizes = await snapshotGit(git,
    cwd,
    ["cat-file", "--batch-check=%(objectsize)"],
    undefined,
    ids,
    objects
  )
  let bytes = 0
  for (const size of sizes.trim().split("\n")) {
    if (!/^\d+$/.test(size))
      throw new Error("A checkpoint object is unavailable")
    bytes += Number(size)
    if (bytes > limit)
      throw new Error(
        "The checkpoint exceeds its object storage limit. No workspace files were changed."
      )
  }
  await snapshotGit(git,
    cwd,
    [
      "pack-objects",
      "--revs",
      "--window=0",
      "--compression=3",
      join(directory, "git/objects/pack/pack"),
    ],
    undefined,
    base ? `${commit}\n^${base}^{tree}\n` : `${commit}\n`,
    objects
  )
  for (const entry of await readdir(join(directory, "git/objects"))) {
    if (/^[a-f0-9]{2}$/.test(entry))
      await rm(join(directory, "git/objects", entry), {
        recursive: true,
        force: true,
      })
  }
  await snapshotGit(git,
    cwd,
    ["cat-file", "-e", `${commit}^{commit}`],
    undefined,
    undefined,
    { write: objects.write }
  )
}
export async function snapshotPayloadBytes(directory: string): Promise<number> {
  let bytes = 0
  const pending = [directory]
  let visited = 0
  while (pending.length) {
    const path = pending.pop()
    if (!path) break
    if (++visited > 100_000)
      throw new Error("Checkpoint storage contains too many files")
    const info = await lstat(path)
    bytes += Math.max(info.size, info.blocks * 512)
    if (info.isDirectory())
      pending.push(...(await readdir(path)).map((name) => join(path, name)))
  }
  return bytes
}
export async function importSnapshotObjects(
  git: Git,
  cwd: string,
  directory: string
): Promise<void> {
  const packs = (await readdir(join(directory, "git/objects/pack"))).filter(
    (name) => name.endsWith(".pack")
  )
  if (packs.length !== 1)
    throw new Error("The private checkpoint pack is missing or damaged")
  await git.run({
    cwd,
    args: ["unpack-objects", "-r"],
    env: environment(),
    input: createReadStream(join(directory, "git/objects/pack", packs[0]!)),
    maxBytes: 4096,
    timeoutMs: 30_000,
  })
}
