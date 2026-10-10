import { existsSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { build, transformSync } from "esbuild"
import { z } from "zod"

/**
 * The host's source files as esbuild resolves them from electron/main.ts,
 * through Mako's own packages; any other package stays external. Imports
 * only used as types are erased and not followed, but the graph still lists
 * them among a file's external imports: `packagesLoadedBy` tells them apart.
 */
export const root = resolve(".")
export const entry = "electron/main.ts"
const Manifest = z.object({ exports: z.record(z.string(), z.string()) })

function packageSource(specifier) {
  const [, name, subpath = ""] = specifier.match(/^@mako\/([^/]+)(?:\/(.+))?$/)
  const directory = join(root, "packages", name)
  const { exports } = Manifest.parse(JSON.parse(readFileSync(join(directory, "package.json"), "utf8")))
  const target = exports[subpath ? `./${subpath}` : "."]
  if (!target) throw new Error(`${specifier} isn't exported by @mako/${name}`)
  const source = join(directory, target.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts"))
  if (!existsSync(source)) throw new Error(`${specifier} has no source at ${relative(root, source)}`)
  return source
}

export async function hostGraph() {
  const { metafile } = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    plugins: [{
      name: "host-sources",
      setup(plugin) {
        plugin.onResolve({ filter: /^@mako\// }, (args) => ({ path: packageSource(args.path) }))
        plugin.onResolve({ filter: /^[^./]/ }, (args) => ({ path: args.path, external: true }))
      },
    }],
  })
  return metafile.inputs
}

/** The package an external specifier names: `@scope/name` or `name`. */
export function packageOf(specifier) {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
}

/**
 * Files loaded while the host starts: static imports from the entry, not
 * `import()`. Each file maps to the file that first imported it.
 */
export function staticallyLoaded(inputs) {
  const parent = new Map([[entry, undefined]])
  const queue = [entry]
  while (queue.length) {
    const file = queue.shift()
    for (const item of inputs[file]?.imports ?? []) {
      if (item.external || item.kind === "dynamic-import" || parent.has(item.path)) continue
      parent.set(item.path, file)
      queue.push(item.path)
    }
  }
  return parent
}

/** `electron/main.ts → … → file`, through first importers. */
export function chainTo(parent, file) {
  const chain = []
  for (let at = file; at; at = parent.get(at)) chain.unshift(at)
  return chain.join(" → ")
}

const STATIC_IMPORT = /^\s*(?:import|export)\b(?:[^"';]*?\bfrom\s*)?["']([^"']+)["']/gm

/** Packages a file imports statically once compiled, as Node loads it. */
export function packagesLoadedBy(file) {
  const { code } = transformSync(readFileSync(join(root, file), "utf8"), {
    loader: file.endsWith(".tsx") ? "tsx" : "ts",
    format: "esm",
  })
  const names = new Set()
  for (const [, specifier] of code.matchAll(STATIC_IMPORT))
    if (!/^(\.|node:|@mako\/)/.test(specifier)) names.add(packageOf(specifier))
  return names
}
