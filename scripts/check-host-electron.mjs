import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import ts from "typescript"
import { entry, hostGraph } from "./lib/host-graph.mjs"

/**
 * The host is a plain Node program: Electron's Helper in Node mode runs it on
 * a Mac, plain Node on a Linux machine with no display. It loads no Electron
 * at all. What only Electron's main process can do belongs to the desktop app
 * (electron/client-main.ts), which the host asks on /desktop
 * (packages/host/src/control/desktop-channel.ts).
 *
 * Two checks. Every file in @mako/host, loaded or not, names neither package,
 * not even for a type: the package installs where Electron doesn't. Electron's
 * Node also offers `original-fs`, its `node:fs` without archive reading; only
 * base/physical-files.ts names it, behind a check that Electron is there. And what
 * the host loads from packages/host/src/host-main.ts (static imports and literal
 * dynamic imports, through Mako's own packages, as esbuild resolves them;
 * type-only imports are erased and don't count) imports neither at run time.
 */
const electron = new Set(["electron", "electron-updater"])
const hostPackage = "packages/host/src"
const physicalFiles = join(hostPackage, "base/physical-files.ts")

const packageFiles = (await readdir(hostPackage, { recursive: true }))
  .filter((name) => /\.tsx?$/.test(name))
  .map((name) => join(hostPackage, name))
const failures = []
for (const file of packageFiles) {
  const { importedFiles } = ts.preProcessFile(await readFile(file, "utf8"), true, true)
  for (const { fileName } of importedFiles)
    if (electron.has(fileName)) failures.push(`${file} imports ${fileName}. @mako/host imports nothing from Electron; ask the desktop app on /desktop (packages/host/src/control/desktop-channel.ts) for what only Electron can do.`)
    else if (fileName === "original-fs" && file !== physicalFiles) failures.push(`${file} imports original-fs. Read the disk as it is through ${physicalFiles}, which works under plain Node too.`)
}

const inputs = await hostGraph()
const own = (file) => !file.includes("node_modules/")
const importsElectron = (file) => inputs[file].imports.some((item) => item.external && electron.has(item.path))

const parent = new Map([[entry, undefined]])
const queue = [entry]
while (queue.length) {
  const file = queue.shift()
  for (const item of inputs[file]?.imports ?? []) {
    if (item.external || parent.has(item.path)) continue
    parent.set(item.path, file)
    queue.push(item.path)
  }
}
const chain = (file) => {
  const files = []
  for (let at = file; at; at = parent.get(at)) files.unshift(at)
  return files.join(" → ")
}
const loading = [...parent.keys()].filter((file) => own(file) && importsElectron(file)).sort()
for (const file of loading)
  failures.push(`${file} imports Electron, and the host loads it: ${chain(file)}. Ask the desktop app on /desktop (packages/host/src/control/desktop-channel.ts) for what only Electron can do.`)
for (const failure of failures) console.error(failure)
if (failures.length) process.exit(1)
console.log(`host electron imports: none in ${packageFiles.length} @mako/host files or ${parent.size} loaded files`)
