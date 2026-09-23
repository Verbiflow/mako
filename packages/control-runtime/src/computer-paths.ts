import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

type ToolArguments = NonNullable<CallToolRequest["params"]["arguments"]>
const pathValue = z.string().min(1)
const pathList = z.array(pathValue)

/** Driver arguments that name one local filesystem path. */
const PATH_FIELDS = [
  "screenshot_out_file",
  "output_dir",
  "destination_root",
  "dir",
  "image_path",
  "file_path",
  "debug_image_out",
] as const

/** Driver arguments that name a list of local filesystem paths. */
const PATH_LIST_FIELDS = ["files"] as const

function expandHome(raw: string): string {
  if (raw === "~") return homedir()
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2))
  return raw
}

/**
 * The native driver inspects the deepest existing ancestor of a proposed
 * output path without following symbolic links, so `/tmp/shot.png` is refused
 * on macOS, where `/tmp` links to `/private/tmp`. Resolve that ancestor here
 * and forward the real path, keeping every component the driver will create.
 * A path that cannot be resolved at all is forwarded unchanged so the driver
 * reports its own refusal.
 */
export async function canonicalDriverPath(
  raw: string,
  cwd = process.cwd()
): Promise<string> {
  const absolute = resolve(cwd, expandHome(raw))
  const missing: string[] = []
  let existing = absolute
  for (;;) {
    try {
      const real = await realpath(existing)
      return join(real, ...missing.reverse())
    } catch {
      const parent = dirname(existing)
      if (parent === existing) return absolute
      missing.push(basename(existing))
      existing = parent
    }
  }
}

/** Return the arguments with every path-valued field resolved for the driver. */
export async function resolveDriverPaths(
  args: ToolArguments,
  cwd = process.cwd()
): Promise<ToolArguments> {
  const resolved = { ...args }
  for (const field of PATH_FIELDS) {
    const value = pathValue.safeParse(resolved[field])
    if (value.success)
      resolved[field] = await canonicalDriverPath(value.data, cwd)
  }
  for (const field of PATH_LIST_FIELDS) {
    const value = pathList.safeParse(resolved[field])
    if (value.success)
      resolved[field] = await Promise.all(
        value.data.map((item) => canonicalDriverPath(item, cwd))
      )
  }
  return resolved
}
