import { execFile } from "node:child_process"
import { createReadStream } from "node:fs"
import { lstat, readFile, readdir, rm } from "node:fs/promises"
import { delimiter, join } from "node:path"
import { pipeline } from "node:stream/promises"
import { promisify } from "node:util"
import { z } from "zod"
import { forgetStartingRepository } from "./git-environment.js"

const execute = promisify(execFile)
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
function environment(
  index?: string,
  objects?: SnapshotObjects
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Mako",
    GIT_AUTHOR_EMAIL: "mako@localhost",
    GIT_COMMITTER_NAME: "Mako",
    GIT_COMMITTER_EMAIL: "mako@localhost",
  }
  forgetStartingRepository(env)
  if (index) env.GIT_INDEX_FILE = index
  if (objects?.write) env.GIT_OBJECT_DIRECTORY = objects.write
  if (objects?.read?.length)
    env.GIT_ALTERNATE_OBJECT_DIRECTORIES = objects.read
      .map((path) => JSON.stringify(path))
      .join(delimiter)
  return env
}
export async function snapshotGit(
  cwd: string,
  args: string[],
  index?: string,
  input?: string,
  objects?: SnapshotObjects
): Promise<string> {
  const result = execute(
    "git",
    ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
    {
      cwd,
      env: environment(index, objects),
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    }
  )
  if (input !== undefined) result.child.stdin?.end(input)
  return (await result).stdout
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
  const result = execute("git", ["unpack-objects", "-r"], {
    cwd,
    env: environment(),
    maxBuffer: 4096,
    timeout: 30_000,
  })
  const input = result.child.stdin
  if (!input) throw new Error("Git checkpoint import has no input pipe")
  await Promise.all([
    result,
    pipeline(
      createReadStream(join(directory, "git/objects/pack", packs[0])),
      input
    ),
  ])
}
