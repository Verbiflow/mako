import { openCodeDatabasePaths } from "@mako/sessions"
export { openCodeDatabasePaths } from "@mako/sessions"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readOpenCodeRecord } from "./resume.js"

export interface OpenCodeInstallation {
  command: string
  generation: "v1" | "v2"
}

/** Candidate discovery is not evidence of the executable's generation. */
function executableCandidates(env: NodeJS.ProcessEnv): string[] {
  return env.OPENCODE_BIN_PATH ? [env.OPENCODE_BIN_PATH] : [
    env.OPENCODE2_BIN_PATH ?? join(homedir(), ".opencode", "bin", "opencode2"),
    env.OPENCODE1_BIN_PATH ?? join(homedir(), ".opencode", "bin", "opencode"),
  ]
}

export function openCodeExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  return executableCandidates(env).find(command => existsSync(command)) ?? null
}

const run = promisify(execFile)

/** Execution checks the binary itself; a wrapper's filename is not a version. */
export async function resolveOpenCodeInstallation(
  preferred?: OpenCodeInstallation["generation"],
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
    const match = /^(?:opencode\s+)?v?([12])\.\d+\.\d+(?:[-+][\w.-]+)?$/i.exec(version)
    if (!match) {
      if (env.OPENCODE_BIN_PATH) throw new Error("The configured OpenCode executable reports an unsupported version.")
      continue
    }
    const generation = match[1] === "2" ? "v2" : "v1"
    if (!preferred || preferred === generation) return { command, generation }
    if (env.OPENCODE_BIN_PATH)
      throw new Error(`The configured OpenCode executable is ${generation}, but this native session requires ${preferred}.`)
  }
  throw new Error(`No verified OpenCode ${preferred ?? "v1/v2"} executable is available.`)
}

export async function openCodeSessionGeneration(
  sessionId: string,
  nativePath?: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<OpenCodeInstallation["generation"]> {
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
  const matches = records.filter(record => record.kind === "available")
  if (matches.length !== 1)
    throw new Error(matches.length > 1
      ? "More than one OpenCode native store matches this session. Its exact source is required."
      : "The OpenCode native session could not be resolved in the configured stores.")
  return matches[0]!.generation
}
