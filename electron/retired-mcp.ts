import { randomUUID } from "node:crypto"
import {
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { z } from "zod"
import type { JsonValue } from "./codex-app-json.js"

const retiredScripts = new Map<string, string>([
  ["mako-browser-use", "browser-tools-main.js"],
  ["mako-local-control", "computer-tools-main.js"],
  ["mako-control", "computer-tools-main.js"],
  ["mako-local-tools", "local-tools-main.js"],
])
const RetiredLaunchSchema = z
  .object({
    command: z.union([z.string(), z.array(z.string())]).optional(),
    args: z.array(z.string()).optional(),
  })
  .transform((value) => ({
    launch: [
      ...(Array.isArray(value.command)
        ? value.command
        : value.command
          ? [value.command]
          : []),
      ...(value.args ?? []),
    ],
  }))
const McpFileSchema = z
  .object({
    mcpServers: z.record(z.string(), z.json()).optional(),
    mcp: z.record(z.string(), z.json()).optional(),
  })
  .catchall(z.json())

export interface RetiredMcpLaunch {
  command?: string | readonly string[]
  args?: readonly string[]
}

export function retiredMakoMcp(
  name: string,
  value: RetiredMcpLaunch
): boolean {
  const script = retiredScripts.get(name)
  if (!script) return false
  const parsed = RetiredLaunchSchema.safeParse(value)
  if (!parsed.success) return false
  const scriptIndex = parsed.data.launch.findIndex(
    (argument) =>
      basename(argument) === script &&
      (basename(dirname(argument)) === "dist-electron" ||
        (basename(dirname(argument)) === "dist" && argument.replaceAll("\\", "/").includes("/@mako/control-runtime/")))
  )
  if (scriptIndex < 1) return false
  const runtime = basename(parsed.data.launch[scriptIndex - 1] ?? "")
  const historicalRuntime =
    /^(?:mako(?:\.exe)?|electron)$/i.test(runtime)
  const nodeMode =
    process.platform === "win32" ||
    parsed.data.launch
      .slice(0, scriptIndex)
      .includes("ELECTRON_RUN_AS_NODE=1")
  return historicalRuntime && nodeMode
}

export function removeRetiredMakoMcp(
  servers: Record<string, JsonValue>
): boolean {
  let changed = false
  for (const [name, value] of Object.entries(servers)) {
    const launch = RetiredLaunchSchema.safeParse(value)
    if (
      launch.success &&
      retiredMakoMcp(name, {
        command: launch.data.launch,
      })
    ) {
      delete servers[name]
      changed = true
    }
  }
  return changed
}

/** One-time removal of Mako's historical native provider registrations. */
export async function migrateRetiredMakoMcpFile(
  file: string
): Promise<boolean> {
  const target = await realpath(file).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    }
  )
  if (target === null) return false
  for (let attempt = 0; attempt < 3; attempt++) {
    const source = await readFile(target, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null
        throw error
      }
    )
    if (source === null) return false
    const root = McpFileSchema.parse(JSON.parse(source))
    const changedServers = root.mcpServers
      ? removeRetiredMakoMcp(root.mcpServers)
      : false
    const changedOpenCode = root.mcp
      ? removeRetiredMakoMcp(root.mcp)
      : false
    const changed = changedServers || changedOpenCode
    if (!changed)
      return false
    const temporary = join(
      dirname(target),
      `.${basename(target)}.${randomUUID()}.tmp`
    )
    await writeFile(temporary, `${JSON.stringify(root, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    })
    try {
      if ((await readFile(target, "utf8")) !== source) continue
      await rename(temporary, target)
      return true
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }
  return false
}
