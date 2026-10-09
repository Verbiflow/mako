import { readFileSync, writeFileSync } from "node:fs"
import { entry, hostGraph } from "./lib/host-graph.mjs"

/**
 * The host is a plain Node program that Electron can also carry: run as
 * Electron's Helper in Node mode, or under plain Node on a Linux machine with
 * no display, it must load no Electron at all. Electron's main process reaches
 * its windows, schemes and app events through one module,
 * electron/host-shell-electron.ts, which main.ts imports only when Electron's
 * main process runs it.
 *
 * Two checks, following static imports and literal dynamic imports from
 * electron/main.ts through Mako's own packages, as esbuild resolves them.
 * Type-only imports are erased before run time and don't count.
 *
 *   - Without the shell, the host imports Electron nowhere.
 *   - With it, the files that import Electron are those recorded in
 *     host-electron-imports.json: a file may leave the list, never join it.
 *
 * `--write` records the current list after a file stops importing Electron.
 */
const recorded = "scripts/host-electron-imports.json"
const shell = "electron/host-shell-electron.ts"
const electron = new Set(["electron", "electron-updater"])
const inputs = await hostGraph()

const own = (file) => !file.includes("node_modules/")
const importsElectron = (file) => inputs[file].imports.some((item) => item.external && electron.has(item.path))

/** What Node loads: every file reachable from the entry without passing through the shell. */
const parent = new Map([[entry, undefined]])
const queue = [entry]
while (queue.length) {
  const file = queue.shift()
  for (const item of inputs[file]?.imports ?? []) {
    if (item.external || item.path === shell || parent.has(item.path)) continue
    parent.set(item.path, file)
    queue.push(item.path)
  }
}
const chain = (file) => {
  const files = []
  for (let at = file; at; at = parent.get(at)) files.unshift(at)
  return files.join(" → ")
}
const underNode = [...parent.keys()].filter((file) => own(file) && importsElectron(file)).sort()
for (const file of underNode)
  console.error(`${file} imports Electron, and the host loads it under Node: ${chain(file)}. Give the host what it needs through electron/host-shell.ts, or ask the desktop app on /desktop (electron/desktop-channel.ts).`)

const loaded = Object.keys(inputs).filter(own)
const importing = loaded.filter(importsElectron).sort()
const allowed = new Set(JSON.parse(readFileSync(recorded, "utf8")))
const joined = importing.filter((file) => !allowed.has(file))
const left = [...allowed].filter((file) => !importing.includes(file))
for (const file of joined)
  console.error(`${file} imports Electron and the host's Electron shell loads it. Keep Electron to the shell's own files: take paths and the version from the host's configuration, and put desktop-only work in the desktop app (electron/client-main.ts).`)
if (process.argv.includes("--write")) {
  if (joined.length || underNode.length) process.exit(1)
  writeFileSync(recorded, JSON.stringify(importing, null, 2) + "\n")
  console.log(`host electron imports: recorded ${importing.length} of ${loaded.length} loaded files`)
  process.exit(0)
}
for (const file of left)
  console.error(`${file} no longer imports Electron, or the host no longer loads it. Run \`node scripts/check-host-electron.mjs --write\` to record the shorter list.`)
if (underNode.length || joined.length || left.length) process.exit(1)
console.log(`host electron imports: none of ${parent.size} files under Node; ${importing.length} through the Electron shell, none new`)
