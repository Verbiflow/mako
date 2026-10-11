import { readdir, readFile } from "node:fs/promises"
import { builtinModules } from "node:module"
import { join } from "node:path"
import ts from "typescript"

/**
 * @mako/host installs on its own, where the desktop app's dependencies aren't
 * there to borrow: every package a file in it imports, type-only imports
 * included, is one of its dependencies. `original-fs` is Electron's Node's own
 * module, which only base/physical-files.ts names (scripts/check-host-electron.mjs).
 */
const root = "packages/host"
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])
const runtime = new Set([...builtinModules, "original-fs"])
const packageOf = (specifier) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/")

const files = (await readdir(join(root, "src"), { recursive: true }))
  .filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".d.ts"))
  .map((name) => join(root, "src", name))
const undeclared = new Map()
for (const file of files) {
  for (const { fileName } of ts.preProcessFile(await readFile(file, "utf8"), true, true).importedFiles) {
    if (fileName.startsWith(".") || fileName.startsWith("node:") || runtime.has(fileName)) continue
    const name = packageOf(fileName)
    if (name !== manifest.name && !declared.has(name)) undeclared.set(name, [...(undeclared.get(name) ?? []), file])
  }
}
for (const [name, importers] of undeclared)
  console.error(`${importers[0]}${importers.length > 1 ? ` and ${importers.length - 1} more` : ""} import ${name}, which packages/host/package.json doesn't list. Add it to the package's dependencies at the version the app uses.`)
if (undeclared.size) process.exit(1)
console.log(`host dependencies: every package the ${files.length} @mako/host files import is declared`)
