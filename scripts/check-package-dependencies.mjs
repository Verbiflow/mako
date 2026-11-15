import { readdir, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { builtinModules } from "node:module"
import { join } from "node:path"
import ts from "typescript"

/**
 * Each package under packages/ installs on its own, where the app's dependencies aren't there to borrow: every package
 * a file of its src/ imports, type-only and bare imports included, is one of its dependencies or peers. That also makes
 * its manifest a true account of which @mako packages it reaches, which `ci-changes.mjs --check-ui-scope` and the
 * gate's path filters stand on. `original-fs` is Electron's Node's own module, which only the host's
 * base/physical-files.ts names (scripts/check-host-electron.mjs).
 */
const RUNTIME = new Set([...builtinModules, "original-fs"])
const packageOf = (specifier) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/")

let checked = 0
let failed = false
for (const folder of (await readdir("packages")).sort()) {
  const root = join("packages", folder)
  if (!existsSync(join(root, "package.json")) || !existsSync(join(root, "src"))) continue
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])
  const files = (await readdir(join(root, "src"), { recursive: true }))
    .filter((name) => /\.(tsx?|mts|mjs|js)$/.test(name) && !name.endsWith(".d.ts"))
    .map((name) => join(root, "src", name))
  const undeclared = new Map()
  for (const file of files) {
    for (const { fileName } of ts.preProcessFile(await readFile(file, "utf8"), true, true).importedFiles) {
      if (fileName.startsWith(".") || fileName.startsWith("node:") || RUNTIME.has(fileName)) continue
      const name = packageOf(fileName)
      if (name !== manifest.name && !declared.has(name)) undeclared.set(name, [...(undeclared.get(name) ?? []), file])
    }
  }
  for (const [name, importers] of undeclared)
    console.error(`${importers[0]}${importers.length > 1 ? ` and ${importers.length - 1} more` : ""} import ${name}, which ${root}/package.json doesn't list. Add it to the package's dependencies at the version the app uses.`)
  failed ||= undeclared.size > 0
  checked += files.length
}
if (failed) process.exit(1)
console.log(`package dependencies: every package the ${checked} files of packages/*/src import is declared by its own package`)
