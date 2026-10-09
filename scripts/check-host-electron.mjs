import { entry, hostGraph } from "./lib/host-graph.mjs"

/**
 * The host is a plain Node program: Electron's Helper in Node mode runs it on
 * a Mac, plain Node on a Linux machine with no display. It loads no Electron
 * at all. What only Electron's main process can do belongs to the desktop app
 * (electron/client-main.ts), which the host asks on /desktop
 * (electron/desktop-channel.ts).
 *
 * Follows static imports and literal dynamic imports from electron/main.ts
 * through Mako's own packages, as esbuild resolves them. Type-only imports are
 * erased before run time and don't count.
 */
const electron = new Set(["electron", "electron-updater"])
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
const importing = [...parent.keys()].filter((file) => own(file) && importsElectron(file)).sort()
for (const file of importing)
  console.error(`${file} imports Electron, and the host loads it: ${chain(file)}. Ask the desktop app on /desktop (electron/desktop-channel.ts) for what only Electron can do.`)
if (importing.length) process.exit(1)
console.log(`host electron imports: none of ${parent.size} files`)
