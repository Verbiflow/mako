import { existsSync, readFileSync } from "node:fs"

/**
 * Every file a package script runs exists. A chained suite stops at the first
 * missing file, so a test deleted without its script entry skips every test
 * after it, unnoticed until the suite next runs in full.
 */
const { scripts } = JSON.parse(readFileSync("package.json", "utf8"))
const file = /(?:^|\s)((?:scripts|electron|packages)\/[\w./-]+\.(?:tsx|ts|mjs|cjs|js))(?=\s|$|&|;|\))/g
let missing = 0
for (const [name, command] of Object.entries(scripts)) {
  for (const match of command.matchAll(file)) {
    if (existsSync(match[1])) continue
    console.error(`package.json "${name}" runs ${match[1]}, which doesn't exist`)
    missing++
  }
}
if (missing) process.exit(1)
