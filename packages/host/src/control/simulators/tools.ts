import { hostCommand } from "../../base/host-command.js"
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { SetupTool } from "../../contracts/simulator-setup.js"
import { environmentForExecutable, resolveExecutable } from "../../base/executable.js"

const execute = hostCommand

/**
 * The tools Mako installs for simulators, each at the version it was read at (2026-11-03). serve-sim's capture and
 * touch and inspect-webkit's bridge run inside Mako's own hub (`electron/simulator-hub-entry.ts`), never as their own
 * servers. agent-device is installed beside them and not run yet: serve-sim's accessibility tree covers what driving
 * by what's on screen needs here.
 */
export const PINNED_TOOLS = [
  {
    name: "serve-sim",
    version: "0.1.48",
    purpose: "Streams a simulator's screen and sends it touches",
    license: "Apache-2.0",
    entry: ["dist", "serve-sim.js"],
  },
  {
    name: "inspect-webkit",
    version: "0.0.5",
    purpose: "Reads Mobile Safari's page through WebKit's inspector",
    license: "MIT",
    entry: ["dist", "cli.js"],
  },
  {
    name: "agent-device",
    version: "0.21.36",
    purpose: "Drives a simulator by what's on screen",
    license: "MIT",
    entry: ["bin", "agent-device.mjs"],
  },
] as const

type ToolSpec = (typeof PINNED_TOOLS)[number]

const SENTINEL = ".install-complete"
const INSTALL_TIMEOUT_MS = 10 * 60_000
/** What `execFile` rejects with when npm ran and failed. */
const NpmFailure = z.object({ stderr: z.string() })

export function toolsRoot(dataRoot: string): string {
  return join(dataRoot, "simulators", "tools")
}

function installDir(root: string, spec: { name: string; version: string }): string {
  return join(root, spec.name, spec.version)
}

/** Where a tool's entry is, once it's installed. */
export function toolEntry(root: string, spec: ToolSpec): string {
  return join(toolPackage(root, spec.name), ...spec.entry)
}

/** A pinned tool's package folder, which the hub loads it from. */
export function toolPackage(root: string, name: ToolSpec["name"]): string {
  const spec = PINNED_TOOLS.find((tool) => tool.name === name)!
  return join(installDir(root, spec), "node_modules", spec.name)
}

/** Each pinned tool, with the version installed when its folder is complete: an entry and a sentinel naming that version. */
export async function readTools(root: string): Promise<SetupTool[]> {
  return Promise.all(
    PINNED_TOOLS.map(async (spec): Promise<SetupTool> => {
      const tool = { name: spec.name, version: spec.version, purpose: spec.purpose, license: spec.license }
      return (await installed(root, spec)) ? { ...tool, installed: spec.version } : tool
    })
  )
}

async function installed(root: string, spec: ToolSpec): Promise<boolean> {
  const [sentinel, entry] = await Promise.all([
    readFile(join(installDir(root, spec), SENTINEL), "utf8").catch(() => null),
    stat(toolEntry(root, spec)).then(() => true, () => false),
  ])
  return entry && sentinel?.trim() === spec.version
}

/**
 * Installs every pinned tool not installed yet, each into a staging folder beside its own and renamed into place
 * once its entry is there, so a folder that exists is a complete install. npm runs no package's scripts. Each
 * installed tool is reported as it lands.
 */
export async function installTools(root: string, landed: (name: string) => void): Promise<void> {
  const npm = resolveExecutable("npm")
  if (!npm) throw new Error("Installing the simulator tools needs npm, which comes with Node.js (nodejs.org).")
  for (const spec of PINNED_TOOLS) {
    if (await installed(root, spec)) continue
    const target = installDir(root, spec)
    await mkdir(join(root, spec.name), { recursive: true })
    const staging = await mkdtemp(join(root, spec.name, ".staging-"))
    try {
      await execute(npm, ["install", "--prefix", staging, "--no-fund", "--no-audit", "--ignore-scripts", "--omit=dev", `${spec.name}@${spec.version}`], {
        env: environmentForExecutable(npm, process.env),
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      }).catch((error) => {
        const stderr = NpmFailure.safeParse(error).data?.stderr.trim().split("\n").slice(-3).join(" ") ?? ""
        throw new Error(`npm couldn't install ${spec.name}@${spec.version}${stderr ? `: ${stderr}` : ""}`)
      })
      await stat(join(staging, "node_modules", spec.name, ...spec.entry)).catch(() => {
        throw new Error(`${spec.name}@${spec.version} installed without its entry, ${spec.entry.join("/")}`)
      })
      await writeFile(join(staging, SENTINEL), `${spec.version}\n`)
      await rm(target, { recursive: true, force: true })
      await rename(staging, target)
      landed(spec.name)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
}
