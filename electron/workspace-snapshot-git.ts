import { createReadStream } from "node:fs"
import { lstat, readFile, readdir, rm } from "node:fs/promises"
import { delimiter, join } from "node:path"
import { z } from "zod"
import { run } from "@mako/git"

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
export async function snapshotGit(
  cwd: string,
  args: string[],
  index?: string,
  input?: string,
  objects?: SnapshotObjects
): Promise<string> {
  const result = await run({
    cwd,
    args: ["-c", "core.fsmonitor=false", ...args],
    read: true,
    env: environment(index, objects),
    input,
    maxBytes: 16 * 1024 * 1024,
    timeoutMs: 30_000,
  })
  if (result.truncated) throw new Error(`git ${args[0] ?? ""} wrote more than 16 MB for a checkpoint`)
  return result.stdout.toString("utf8")
}
export async function privateSnapshotObjects(
  cwd: string,
  directory: string
): Promise<SnapshotObjects> {
  const format = (
    await snapshotGit(cwd, ["rev-parse", "--show-object-format"])
  ).trim()
  const source = (
    await snapshotGit(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ])
  ).trim()
  await snapshotGit(cwd, [
    "init",
    "--bare",
    "--quiet",
    "--template=",
    `--object-format=${format}`,
    join(directory, "git"),
  ])
  return { write: join(directory, "git", "objects"), read: [source] }
}
export async function sealSnapshotObjects(
  cwd: string,
  directory: string,
  commit: string,
  objects: SnapshotObjects,
  limit: number
): Promise<void> {
  const ids = await snapshotGit(
    cwd,
    ["rev-list", "--objects", "--no-object-names", commit],
    undefined,
    undefined,
    objects
  )
  const sizes = await snapshotGit(
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
  await snapshotGit(
    cwd,
    [
      "pack-objects",
      "--revs",
      "--window=0",
      "--compression=3",
      join(directory, "git/objects/pack/pack"),
    ],
    undefined,
    `${commit}\n`,
    objects
  )
  for (const entry of await readdir(join(directory, "git/objects"))) {
    if (/^[a-f0-9]{2}$/.test(entry))
      await rm(join(directory, "git/objects", entry), {
        recursive: true,
        force: true,
      })
  }
  await snapshotGit(
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
  cwd: string,
  directory: string
): Promise<void> {
  const packs = (await readdir(join(directory, "git/objects/pack"))).filter(
    (name) => name.endsWith(".pack")
  )
  if (packs.length !== 1)
    throw new Error("The private checkpoint pack is missing or damaged")
  await run({
    cwd,
    args: ["unpack-objects", "-r"],
    env: environment(),
    input: createReadStream(join(directory, "git/objects/pack", packs[0]!)),
    maxBytes: 4096,
    timeoutMs: 30_000,
  })
}
