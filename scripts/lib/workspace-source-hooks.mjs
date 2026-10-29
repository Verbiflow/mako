import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"

/**
 * Module resolution hooks for `useWorkspaceSource` (workspace-source.mjs):
 * a `@mako/<name>` import resolves to the TypeScript source of the file its
 * package exports, when the checkout has it.
 */

/** Each workspace package by its name: its folder and what each subpath exports, as a file. */
const packages = new Map()

const exportTarget = z.union([z.string(), z.object({ import: z.string().optional(), default: z.string().optional() }).transform((target) => target.import ?? target.default ?? null)])
const manifest = z.object({ name: z.string(), main: z.string().optional(), exports: z.record(z.string(), exportTarget).optional() })

export function initialize({ root }) {
  const folder = join(root, "packages")
  for (const name of readdirSync(folder)) {
    const path = join(folder, name, "package.json")
    if (!existsSync(path)) continue
    const parsed = manifest.safeParse(JSON.parse(readFileSync(path, "utf8")))
    if (parsed.success)
      packages.set(parsed.data.name, { dir: join(folder, name), exports: parsed.data.exports ?? (parsed.data.main ? { ".": parsed.data.main } : {}) })
  }
}

/** The file `exports` maps `subpath` to, `*` patterns included; null when it maps none. */
function exported(exports, subpath) {
  if (exports[subpath] !== undefined) return exports[subpath]
  for (const [key, value] of Object.entries(exports)) {
    const star = key.indexOf("*")
    if (star === -1) continue
    const [before, after] = [key.slice(0, star), key.slice(star + 1)]
    if (subpath.startsWith(before) && subpath.endsWith(after) && subpath.length >= key.length - 1)
      return value?.replace("*", subpath.slice(before.length, subpath.length - after.length)) ?? null
  }
  return null
}

export async function resolve(specifier, context, next) {
  const match = /^(@mako\/[^/]+)(\/.+)?$/.exec(specifier)
  const workspace = match && packages.get(match[1])
  const file = workspace && exported(workspace.exports, match[2] ? `.${match[2]}` : ".")
  const compiled = file && /^\.\/dist\/(.+)\.js$/.exec(file)
  if (compiled) {
    const source = join(workspace.dir, "src", `${compiled[1]}.ts`)
    if (existsSync(source)) return { url: pathToFileURL(source).href, shortCircuit: true }
  }
  return next(specifier, context)
}
