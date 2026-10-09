import { readFileSync, writeFileSync } from "node:fs"
import { hostGraph } from "./lib/host-graph.mjs"

/**
 * The host is becoming a plain Node program that runs without Electron, on a
 * Mac and on a Linux machine with no display. This lists every source file the
 * host loads at run time that imports Electron, and holds that list to the one
 * recorded in host-electron-imports.json: a file may leave it, never join it.
 *
 * "Loads" follows static imports and literal dynamic imports from
 * electron/main.ts, through Mako's own packages, as esbuild resolves them.
 * Type-only imports are erased before run time and don't count.
 *
 * `--write` records the current list after a file stops importing Electron.
 */
const recorded = "scripts/host-electron-imports.json"
const electron = new Set(["electron", "electron-updater"])
const inputs = await hostGraph()

const loaded = Object.keys(inputs).filter((file) => !file.includes("node_modules/"))
const importing = loaded
  .filter((file) => inputs[file].imports.some((item) => item.external && electron.has(item.path)))
  .sort()

const allowed = new Set(JSON.parse(readFileSync(recorded, "utf8")))
const joined = importing.filter((file) => !allowed.has(file))
const left = [...allowed].filter((file) => !importing.includes(file))
for (const file of joined)
  console.error(`${file} imports Electron and the host loads it. The host must run without Electron: take paths and the version from the host's configuration, and put desktop-only work in electron/client-main.ts's process.`)
if (process.argv.includes("--write")) {
  if (joined.length) process.exit(1)
  writeFileSync(recorded, JSON.stringify(importing, null, 2) + "\n")
  console.log(`host electron imports: recorded ${importing.length} of ${loaded.length} loaded files`)
  process.exit(0)
}
for (const file of left)
  console.error(`${file} no longer imports Electron, or the host no longer loads it. Run \`node scripts/check-host-electron.mjs --write\` to record the shorter list.`)
if (joined.length || left.length) process.exit(1)
console.log(`host electron imports: ${importing.length} of ${loaded.length} loaded files, none new`)
