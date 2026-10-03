import { homedir } from "node:os"
import { join } from "node:path"
import { childHistory } from "../electron/watch-backend.js"

const history = childHistory()
const roots = ["Library/Application Support", "Library/Caches", "Library/Preferences", "Library/Logs", "Library/LaunchAgents", "Library/Containers", ".config", ".cache", ".local/share", ".local/state"].map((name) => join(homedir(), name))
roots.push("/private/tmp")
let at = performance.now()
const first = await history.mark()
console.log(`cold mark ${Math.round(performance.now() - at)} ms`)
at = performance.now()
await history.mark()
console.log(`warm mark ${Math.round(performance.now() - at)} ms`)
const seconds = Number(process.argv[2] ?? 20)
await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
at = performance.now()
const read = await history.since(first, roots)
console.log(`since ${seconds}s: ${Math.round(performance.now() - at)} ms, ${read.paths.length} paths (${new Set(read.paths).size} distinct), lost ${read.lost.length}`)
at = performance.now()
const again = await history.since(first, roots)
console.log(`again: ${Math.round(performance.now() - at)} ms, ${again.paths.length} paths`)
