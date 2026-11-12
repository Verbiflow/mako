import { realpath, stat } from "node:fs/promises"
import { basename } from "node:path"
import { ADVERTISED_CLIS } from "../base/capabilities.js"
import { environmentForExecutable, resolveExecutable } from "../base/executable.js"
import type { HarnessUpdates } from "../contracts/harness-updates.js"
import { parseVersion } from "../contracts/runtime-version.js"
import type { DiscoveryProcesses } from "./discovery-process.js"
import { readRuntimeVersion } from "./runtime-updates.js"

/** The arguments a tool says its version to, where `--version` isn't it. */
const VERSION_ARGS = new Map([
  ["kubectl", ["version", "--client"]],
  ["xcodebuild", ["-version"]],
])

export interface CliReadingsDeps {
  /** RuntimeUpdates' readings: each runtime's binary and the version installed there. */
  installed(): HarnessUpdates
  processes: DiscoveryProcesses
  /** Where a command resolves, as a launch would find it; null when it isn't here. */
  resolve?(command: string): string | null
  /** A binary's identity, so a reading is taken again only when the binary changed. */
  signature?(binary: string): Promise<string>
  /** A binary's version output (`readRuntimeVersion`). */
  version?(binary: string, args: string[]): Promise<string>
}

/**
 * The command-line tools on this device by name and installed version, as advertisements carry them: RuntimeUpdates'
 * installed readings first, and for each advertised tool it doesn't read, one version read through the same path
 * (`readRuntimeVersion` on the discovery processes), kept while the binary is unchanged. A tool that isn't here, or
 * that won't say a version, is left out.
 */
export class CliReadings {
  readonly #deps: Required<Omit<CliReadingsDeps, "installed" | "processes">> & Pick<CliReadingsDeps, "installed">
  readonly #kept = new Map<string, { signature: string; version: string | undefined }>()

  constructor(deps: CliReadingsDeps) {
    this.#deps = {
      installed: deps.installed,
      resolve: deps.resolve ?? ((command) => resolveExecutable(command)),
      signature: deps.signature ?? binarySignature,
      version: deps.version ?? ((binary, args) => readRuntimeVersion(deps.processes, binary, args, environmentForExecutable(binary, process.env))),
    }
  }

  async read(): Promise<Array<{ command: string; version: string }>> {
    const found = new Map<string, string>()
    for (const reading of Object.values(this.#deps.installed())) {
      const command = reading.binary && basename(reading.binary)
      if (command && reading.installed && !found.has(command)) found.set(command, reading.installed)
    }
    const unread = ADVERTISED_CLIS.filter((command) => !found.has(command))
    const read = await Promise.all(unread.map(async (command) => [command, await this.#version(command)] as const))
    for (const [command, version] of read) if (version) found.set(command, version)
    return [...found].map(([command, version]) => ({ command, version }))
  }

  async #version(command: string): Promise<string | undefined> {
    const binary = this.#deps.resolve(command)
    if (!binary) return undefined
    const signature = await this.#deps.signature(binary).catch(() => undefined)
    if (signature === undefined) return undefined
    const kept = this.#kept.get(command)
    if (kept?.signature === signature) return kept.version
    const version = await this.#deps.version(binary, VERSION_ARGS.get(command) ?? ["--version"]).then(parseVersion, () => undefined)
    this.#kept.set(command, { signature, version })
    return version
  }
}

async function binarySignature(binary: string): Promise<string> {
  const path = await realpath(binary)
  const { mtimeMs, size } = await stat(path)
  return `${path}\n${mtimeMs}\n${size}`
}
