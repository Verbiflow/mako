import { readFileSync } from "node:fs"
import { hostGraph } from "./lib/host-graph.mjs"

/**
 * The host asks which operating system it runs on in one place,
 * packages/host/src/base/platform.ts, and each of Mako's other packages in its
 * own src/platform.ts, since they can't import the host's. Domains are given what the machine can do
 * (`machine.ts`, `keychain.ts`) rather than branching on the platform; what
 * still needs the answer imports it from there, so a Linux host is one module
 * to read, not fifty.
 *
 * This fails on every other source file the host loads that reads
 * `process.platform` itself.
 */
const owners = (file) => file === "packages/host/src/base/platform.ts" || /^packages\/[^/]+\/src\/platform\.ts$/.test(file)
const inputs = await hostGraph()
const reads = Object.keys(inputs)
  .filter((file) => !file.includes("node_modules/") && !owners(file))
  .filter((file) => /\bprocess\.platform\b/.test(readFileSync(file, "utf8")))
  .sort()

for (const file of reads)
  console.error(`${file} reads process.platform. Import onMac, onLinux, onWindows or nodePlatform from @mako/host/base/platform (another package's from its own src/platform.ts), or take the capability the platform decides as an argument.`)
if (reads.length) process.exit(1)
console.log(`host platform reads: none besides the platform modules in ${Object.keys(inputs).length} loaded files`)
