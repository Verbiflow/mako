/**
 * One Vite dev server for every UI check in a job, so each one's pages load already compiled rather than compiling
 * them cold in a server of its own (`scripts/lib/ui-vite.mjs`). Prints the URL, then serves until it's stopped.
 *
 *   node scripts/ui-vite-server.mjs --port 5310            plain: export MAKO_UI_VITE_URL=http://127.0.0.1:5310/
 *   node scripts/ui-vite-server.mjs --port 5311 --manual   reloads by hand: export MAKO_UI_VITE_MANUAL_URL=…
 */
import { createServer } from "vite"
import { manualDevUpdates } from "../electron/dev-updates.mjs"
import { MANUAL_RELOAD } from "./lib/ui-vite.mjs"

const args = process.argv.slice(2)
const portAt = args.indexOf("--port")
const port = portAt === -1 ? Number.NaN : Number(args[portAt + 1])
if (!Number.isInteger(port) || port <= 0) {
  console.error("Usage: node scripts/ui-vite-server.mjs --port <port> [--manual]")
  process.exit(64)
}
const manual = args.includes("--manual")
const options = { server: { host: "127.0.0.1", port, strictPort: true, hmr: false, fs: { strict: false }, watch: { ignored: ["**"] } } }
if (manual) {
  options.define = MANUAL_RELOAD
  options.plugins = [manualDevUpdates()]
  // The checks that reload by hand keep the update channel their own servers had; nothing is watched, so nothing on it
  // reloads a page under a check.
  delete options.server.hmr
}
const server = await createServer(options)
await server.listen()
console.log(`UI Vite server${manual ? " (manual reload)" : ""}: ${server.resolvedUrls.local[0]}`)
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void server.close().then(() => process.exit(0)))
