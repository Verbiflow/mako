import { readFileSync, writeFileSync } from "node:fs"
import { hostGraph } from "./lib/host-graph.mjs"

/**
 * The host asks which operating system it runs on in one place,
 * electron/platform.ts, and each of Mako's packages in its own
 * src/platform.ts, since a package can't import the host's. Domains are given what the machine can do
 * (`machine.ts`, `keychain.ts`) rather than branching on the platform; what
 * still needs the answer imports it from there, so a Linux host is one module
 * to read, not fifty.
 *
 * This lists every source file the host loads, the Electron shell included,
 * that reads `process.platform` itself, and holds it to the list recorded in
 * host-platform-reads.json: a file may leave it, never join it.
 *
 * `--write` records the current list after a file stops reading it.
 */
const recorded = "scripts/host-platform-reads.json"
const owners = (file) => file === "electron/platform.ts" || /^packages\/[^/]+\/src\/platform\.ts$/.test(file)
const inputs = await hostGraph()
const reads = Object.keys(inputs)
  .filter((file) => !file.includes("node_modules/") && !owners(file))
  .filter((file) => /\bprocess\.platform\b/.test(readFileSync(file, "utf8")))
  .sort()

const allowed = new Set(JSON.parse(readFileSync(recorded, "utf8")))
const joined = reads.filter((file) => !allowed.has(file))
const left = [...allowed].filter((file) => !reads.includes(file))
for (const file of joined)
  console.error(`${file} reads process.platform. Import onMac, onLinux, onWindows or nodePlatform from electron/platform.ts (a package's from its own src/platform.ts), or take the capability the platform decides as an argument.`)
if (process.argv.includes("--write")) {
  if (joined.length) process.exit(1)
  writeFileSync(recorded, JSON.stringify(reads, null, 2) + "\n")
  console.log(`host platform reads: recorded ${reads.length} files`)
  process.exit(0)
}
for (const file of left)
  console.error(`${file} no longer reads process.platform, or the host no longer loads it. Run \`node scripts/check-host-platform.mjs --write\` to record the shorter list.`)
if (joined.length || left.length) process.exit(1)
console.log(`host platform reads: ${reads.length} files besides the platform modules, none new`)
