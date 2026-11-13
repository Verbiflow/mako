import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { createServer } from "node:http"
import { extname, join, normalize, resolve } from "node:path"

/**
 * Serves the renderer built for the UI suites (`npm run build:ui-test`, `dist-ui-test/`) at the paths their dev server
 * served it (`/`, `/scripts/phone-apex.html`, `/assets/…`), so every suite of a shard loads one build where each used to
 * start a dev server and compile its pages cold. Prints its base URL, which the shard hands each suite as
 * `MAKO_UI_VITE_URL`, and writes it to `$GITHUB_ENV` when CI runs it. It keeps serving until it's stopped.
 *
 *   node scripts/ci-ui-serve.mjs [dir] [--port <n>]     0 (the default) takes any free port
 */
const args = process.argv.slice(2)
const portAt = args.indexOf("--port")
const port = portAt === -1 ? 0 : Number(args.splice(portAt, 2)[1])
const root = resolve(args[0] ?? "dist-ui-test")

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".mp4": "video/mp4",
  ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8",
}

/** The file a request names inside the build, or the folder's index.html; never a path outside it. */
async function fileOf(url) {
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname)
  const path = normalize(join(root, pathname))
  if (path !== root && !path.startsWith(`${root}/`)) return undefined
  const found = await stat(path).catch(() => undefined)
  if (found?.isDirectory()) return (await stat(join(path, "index.html")).catch(() => undefined))?.isFile() ? join(path, "index.html") : undefined
  return found?.isFile() ? path : undefined
}

const server = createServer(async (request, response) => {
  const file = await fileOf(request.url ?? "/")
  if (!file) {
    response.writeHead(404, { "content-type": "text/plain" }).end(`Not in the UI build: ${request.url}`)
    return
  }
  response.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" })
  createReadStream(file).pipe(response)
})

server.listen(port, "127.0.0.1", async () => {
  // A TCP listen's address names its port; the port asked for stands in if it can't be read.
  const url = `http://127.0.0.1:${server.address()?.port ?? port}/`
  console.log(url)
  if (process.env.GITHUB_ENV) {
    const { appendFile } = await import("node:fs/promises")
    await appendFile(process.env.GITHUB_ENV, `MAKO_UI_VITE_URL=${url}\n`)
  }
})
