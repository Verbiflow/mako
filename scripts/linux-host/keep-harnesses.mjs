import assert from "node:assert/strict"
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

/**
 * The host's install with only the payloads of the harnesses a device is given: what the install carries for one
 * harness alone, and that the host finds missing as it finds a harness not installed, offering it in Settings
 * (`harnesses/<harness>/runtime.ts`). Claude Code's build is the only such payload today: the Agent SDK's platform
 * package, 356 MB on Linux x64, which npm installs with the SDK whatever the list. The SDK's JavaScript (5 MB) stays,
 * as the host's install resolves it either way. Codex, Devin, Grok and OpenCode run a CLI that install-harnesses.mjs
 * installs only when listed (Devin's kept build too, seed-harnesses.mjs); Cursor's SDK stays, as Settings' install
 * of Cursor puts only its CLI in place.
 *
 *   node keep-harnesses.mjs <install root> [<harness>... | none]
 */
const [root, ...named] = process.argv.slice(2)
assert.ok(root, "Pass the install root, the folder holding node_modules")
const kept = new Set(named.filter((name) => name !== "none"))
/** Each harness's payload in the install: folders under node_modules, by the name's start. */
const PAYLOADS = { claude: [["@anthropic-ai", "claude-agent-sdk-"]] }

let bytes = 0
for (const [harness, payloads] of Object.entries(PAYLOADS)) {
  if (kept.has(harness)) continue
  for (const [scope, prefix] of payloads) {
    const folder = resolve(root, "node_modules", scope)
    if (!existsSync(folder)) continue
    for (const name of readdirSync(folder).filter((entry) => entry.startsWith(prefix))) {
      bytes += sizeOf(join(folder, name))
      rmSync(join(folder, name), { recursive: true })
      console.log(`keep-harnesses: ${harness} isn't among ${named.join(" ") || "none"}; removed ${scope}/${name}`)
    }
  }
}
console.log(`keep-harnesses: ${(bytes / 2 ** 20).toFixed(1)} MB of unlisted harnesses' payloads removed`)

function sizeOf(path) {
  const info = lstatSync(path)
  return info.isDirectory() ? readdirSync(path).reduce((sum, name) => sum + sizeOf(join(path, name)), 0) : info.size
}
