import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { promisify } from "node:util"
import type { CuaDriverStatus } from "../contracts/mcp-skills-integrations.js"

const execute = promisify(execFile)

/**
 * The driver release whose embedded contract Mako last verified end to end:
 * `serve --embedded --socket`, `mcp --embedded --socket`, session lifetime
 * bound to the MCP transport, and the tool surface the wrapper relies on.
 */
export const VERIFIED_CUA_DRIVER_VERSION = "0.28.0"
export const UPDATE_TIMEOUT_MS = 4 * 60_000

export type CommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number
) => Promise<{ stdout: string; stderr: string }>

const defaultRunner: CommandRunner = async (command, args, timeoutMs) =>
  execute(command, args, {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  })

export function parseCuaDriverVersion(output: string): string | null {
  const match = /cua-driver\s+v?(\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?)/.exec(
    output
  )
  return match ? match[1] : null
}

export function compareVersions(left: string, right: string): number {
  const a = left.split("+")[0].split(".").map(Number)
  const b = right.split("+")[0].split(".").map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * The installed driver's version as Mako reads it, each executable read once
 * until it changes on disk, and its own updater.
 */
export class CuaDriverVersions {
  readonly #run: CommandRunner
  readonly #read = new Map<string, { modified: number; status: CuaDriverStatus }>()

  constructor(run: CommandRunner = defaultRunner) {
    this.#run = run
  }

  async status(executable: string | null): Promise<CuaDriverStatus> {
    if (!executable)
      return {
        executable: null,
        version: null,
        verified: VERIFIED_CUA_DRIVER_VERSION,
        outdated: false,
        detail: "CUA Driver is not installed",
      }
    const modified = await stat(executable)
      .then((info) => info.mtimeMs)
      .catch(() => 0)
    const cached = this.#read.get(executable)
    if (cached && cached.modified === modified && modified !== 0)
      return cached.status
    const status = await readStatus(executable, this.#run)
    this.#read.set(executable, { modified, status })
    return status
  }

  /**
   * Run the driver's own updater. It downloads the current release through the
   * canonical installer, replaces the app bundle, and stops running daemons, so
   * the caller must restart Mako's embedded driver afterwards.
   */
  async update(executable: string): Promise<{ output: string }> {
    const { stdout: installed } = await this.#run(executable, ["--version"], 8_000)
    if (parseCuaDriverVersion(installed)?.includes("+mako.")) {
      throw new Error(
        "This Mako driver build must be updated with its signed Mako driver package."
      )
    }
    // Host calls time out after five minutes; the updater gets the rest.
    const { stdout, stderr } = await this.#run(
      executable,
      ["update", "--apply"],
      UPDATE_TIMEOUT_MS
    )
    this.#read.clear()
    return { output: `${stdout}\n${stderr}`.trim().slice(-4_000) }
  }
}

async function readStatus(executable: string, run: CommandRunner): Promise<CuaDriverStatus> {
  try {
    const { stdout } = await run(executable, ["--version"], 8_000)
    const version = parseCuaDriverVersion(stdout)
    const outdated =
      version !== null &&
      compareVersions(version, VERIFIED_CUA_DRIVER_VERSION) < 0
    return {
      executable,
      version,
      verified: VERIFIED_CUA_DRIVER_VERSION,
      outdated,
      detail: version
        ? outdated
          ? `CUA Driver ${version} is older than the verified ${VERIFIED_CUA_DRIVER_VERSION}`
          : `CUA Driver ${version}`
        : "CUA Driver did not report a version",
    }
  } catch (error) {
    return {
      executable,
      version: null,
      verified: VERIFIED_CUA_DRIVER_VERSION,
      outdated: false,
      detail:
        error instanceof Error
          ? `CUA Driver version check failed: ${error.message}`
          : "CUA Driver version check failed",
    }
  }
}
