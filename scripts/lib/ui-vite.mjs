import { isDeepStrictEqual } from "node:util"

/** What a shared server's own options are, and what a check may ask of its server and still be served by it. */
const SERVER_KEYS = new Set(["host", "port", "strictPort", "hmr", "watch", "fs"])
export const MANUAL_RELOAD = { "import.meta.env.MAKO_MANUAL_RELOAD": "true" }
const MANUAL_PLUGIN = "mako-manual-updates"

/**
 * The shared server a check's options fit, if the job started one: `MAKO_UI_VITE_URL` for a plain dev server,
 * `MAKO_UI_VITE_MANUAL_URL` for one that reloads by hand (`manualDevUpdates`). A check asking for anything else (its
 * own plugin, root or port) has its own server.
 */
function sharedUrl(options) {
  const { cacheDir: _cacheDir, server = {}, define, plugins, ...rest } = options
  if (Object.keys(rest).length || Object.keys(server).some((key) => !SERVER_KEYS.has(key)) || Number(server.port ?? 0) !== 0) return undefined
  const manual = define !== undefined || plugins !== undefined
  if (manual && !(isDeepStrictEqual(define, MANUAL_RELOAD) && plugins?.length === 1 && plugins[0]?.name === MANUAL_PLUGIN)) return undefined
  const url = manual ? process.env.MAKO_UI_VITE_MANUAL_URL : process.env.MAKO_UI_VITE_URL
  return url ? new URL(url).href : undefined
}

/**
 * The Vite dev server a UI check loads its pages from, in the shape of Vite's own (`listen`, `resolvedUrls`, `close`).
 * Each check started its own, and on a runner its first pages spent seconds compiling what the check before had
 * compiled too. A job that starts one server for all its checks (`scripts/ui-vite-server.mjs`) names it in the
 * environment, and every check whose options it shares loads from it; the rest, and a check run alone, start their own
 * as before.
 */
export async function uiVite(options) {
  const url = sharedUrl(options)
  if (url) return { listen: async () => undefined, close: async () => undefined, resolvedUrls: { local: [url], network: [] } }
  const { createServer } = await import("vite")
  return createServer(options)
}
