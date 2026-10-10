import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { openCodeImport, type EmitResult, type Thread } from "@mako/sessions"
import { resolveOpenCodeInstallation, verifyOpenCodeSession } from "./installation.js"

const run = promisify(execFile)

/**
 * Brings a thread into OpenCode through `opencode session import`, which
 * owns its store's schema. `--standalone` runs the import in its own server
 * rather than one the user has open.
 */
export async function emitOpenCodeSession(thread: Thread, env: NodeJS.ProcessEnv): Promise<EmitResult> {
  const { sessionId, directory, document } = await openCodeImport(thread)
  const installation = await resolveOpenCodeInstallation(env)
  const scratch = await mkdtemp(join(tmpdir(), "mako-opencode-import-"))
  try {
    const file = join(scratch, "session.json")
    await writeFile(file, JSON.stringify(document), { encoding: "utf8", mode: 0o600 })
    const { stdout } = await run(installation.command, ["session", "import", "--standalone", "--directory", directory, file], {
      cwd: scratch, env, timeout: 60_000, maxBuffer: 1 << 20,
    })
    if (!stdout.includes(sessionId)) throw new Error("OpenCode did not import the session under the id Mako gave it")
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  return { sessionId, path: await verifyOpenCodeSession(sessionId, undefined, env) }
}
