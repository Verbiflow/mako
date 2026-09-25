import { existsSync } from "node:fs"
import { createHash } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { runDiscovery } from "../profile-transport.js"

const OwnerSchema = z.discriminatedUnion("state", [
  z.object({
    version: z.literal(1),
    state: z.literal("active"),
    pid: z.number().int().positive(),
  }),
  z.object({ version: z.literal(1), state: z.literal("cleanup") }),
])
// Devin issues both UUIDs and word-based IDs. Keep CLI arguments bounded and
// unable to become flags; ownership comes from the exact workspace query below.
const SessionSchema = z.object({ id: z.string().min(1).max(512).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/) })

export async function withDevinProbeWorkspace<T>(
  executable: string,
  env: NodeJS.ProcessEnv,
  run: (workspace: string) => Promise<T>
): Promise<T> {
  const database = join(
    env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "devin",
    "cli",
    "sessions.db"
  )
  const root = join(
    tmpdir(),
    "mako-devin-probes",
    createHash("sha256").update(database).digest("hex").slice(0, 16)
  )
  await mkdir(root, { recursive: true, mode: 0o700 })
  for (const entry of (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("probe-"))
    .slice(0, 8)) {
    let workspace: string
    try {
      workspace = await realpath(join(root, entry.name))
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        continue
      throw error
    }
    const owner = await readFile(join(workspace, "owner.json"), "utf8")
      .then((text) => OwnerSchema.safeParse(JSON.parse(text)))
      .catch(() => null)
    if (!owner?.success) continue
    if (owner.data.state === "active") {
      try {
        process.kill(owner.data.pid, 0)
        continue
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ESRCH"
        )
          continue
      }
    }
    await removeProbe(executable, env, database, workspace)
  }
  const workspace = await realpath(await mkdtemp(join(root, "probe-")))
  await writeFile(
    join(workspace, "owner.json"),
    JSON.stringify({ version: 1, state: "active", pid: process.pid })
  )
  try {
    return await run(workspace)
  } finally {
    await writeFile(
      join(workspace, "owner.json"),
      JSON.stringify({ version: 1, state: "cleanup" })
    )
    await removeProbe(executable, env, database, workspace)
  }
}

async function removeProbe(
  executable: string,
  env: NodeJS.ProcessEnv,
  database: string,
  workspace: string
): Promise<void> {
  for (const id of probeSessionIds(database, workspace)) {
    try {
      await runDiscovery(
        executable,
        ["rm", "--force", id],
        env,
        undefined,
        workspace
      )
    } catch (error) {
      if (probeSessionIds(database, workspace).includes(id)) throw error
    }
  }
  if (probeSessionIds(database, workspace).length)
    throw new Error(
      "Devin did not remove its discovery session; cleanup ownership was retained"
    )
  await rm(workspace, { recursive: true, force: true })
}

function probeSessionIds(database: string, workspace: string): string[] {
  if (!existsSync(database)) return []
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    return z
      .array(SessionSchema)
      .parse(
        db
          .prepare("SELECT id FROM sessions WHERE working_directory = ?")
          .all(workspace)
      )
      .map((row) => row.id)
  } finally {
    db.close()
  }
}
