import { openCodeDatabasePaths } from "@mako/sessions"
export { openCodeDatabasePaths } from "@mako/sessions"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { isOpenCodeV2 } from "./version.js"
import { readOpenCodeRecord } from "./resume.js"

export interface OpenCodeInstallation {
  command: string
  generation: "v2"
}

/** Candidate discovery is not evidence of the executable's generation. */
function executableCandidates(env: NodeJS.ProcessEnv): string[] {
  return env.OPENCODE_BIN_PATH ? [env.OPENCODE_BIN_PATH] : [
    env.OPENCODE2_BIN_PATH ?? join(homedir(), ".opencode", "bin", "opencode2"),
    join(homedir(), ".opencode", "bin", "opencode"),
  ]
}

export function openCodeExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  return executableCandidates(env).find(command => existsSync(command)) ?? null
}

const run = promisify(execFile)

/** Execution checks the binary itself; a wrapper's filename is not a version. */
export async function resolveOpenCodeInstallation(
  env: NodeJS.ProcessEnv = process.env
): Promise<OpenCodeInstallation> {
  const candidates = executableCandidates(env)
  for (const command of new Set(candidates)) {
    if (!existsSync(command)) continue
    let version: string
    try {
      version = (await run(command, ["--version"], { env, timeout: 3_000, maxBuffer: 4_096 })).stdout.trim()
    } catch {
      if (env.OPENCODE_BIN_PATH) throw new Error("The configured OpenCode executable did not report its version.")
      continue
    }
    if (isOpenCodeV2(version)) return { command, generation: "v2" }
    if (env.OPENCODE_BIN_PATH)
      throw new Error("Mako supports OpenCode v2 only. The configured executable is not a supported v2 release.")
  }
  throw new Error("No verified OpenCode v2 executable is available. Install OpenCode v2 or configure OPENCODE_BIN_PATH.")
}

export async function verifyOpenCodeSession(
  sessionId: string,
  nativePath?: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const databases = openCodeDatabasePaths(env)
  if (nativePath && !databases.some(database => nativePath.startsWith(`${database}#`)))
    throw new Error("The saved OpenCode session belongs to a different native store configuration.")
  const paths = nativePath ? [nativePath] : databases.flatMap(database => [
    `${database}#${encodeURIComponent(sessionId)}`,
    `${database}#v2:${encodeURIComponent(sessionId)}`,
  ])
  const records = await Promise.all(paths.map(path => readOpenCodeRecord({
    id: "runtime-resolution", provider: "opencode", nativeId: sessionId, path, coveredBlocks: 0, includesBase: false,
  })))
  if (nativePath && records[0]?.kind === "unavailable") throw new Error(records[0].reason)
  const matches = records.filter(record => record.kind === "available")
  if (matches.length !== 1)
    throw new Error(matches.length > 1
      ? "More than one OpenCode native store matches this session. Its exact source is required."
      : "The OpenCode native session could not be resolved in the configured stores.")
}
