import { stat } from "node:fs/promises"
import { createServer } from "node:http"
import { Readable } from "node:stream"
import { fileIdentity, filePreviewUrl } from "@mako/host/workspaces/file-previews"
import { readSignedFile } from "@mako/host/workspaces/file-readers"
import { MediaRenditions } from "@mako/host/workspaces/media-renditions"

/**
 * Another host, as `test-owned-files.ts` reaches one: a process of its own, so it signs with a secret of its own. On
 * its socket, `/sign?path=…` answers the URL it signs for a file (a folder grant for a page), and `/file/…` serves
 * its signed files as a host's socket does (`readSignedFile`).
 */
const [socket, folder] = process.argv.slice(2)
if (!socket || !folder) throw new Error("owned-files-owner <socket> <folder>")
const renditions = new MediaRenditions({ folder, ffmpeg: () => "ffmpeg-not-here" })
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://owner")
    if (url.pathname === "/sign") {
      const path = url.searchParams.get("path")!
      const signed = filePreviewUrl(path, fileIdentity(await stat(path)), { folder: path.endsWith(".html") })
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ previewUrl: signed }))
      return
    }
    if (!url.pathname.startsWith("/file/")) return void response.writeHead(404).end()
    const headers = new Headers(request.headers.range ? { range: request.headers.range } : {})
    const answer = await readSignedFile(new Request(`mako-file://${(request.url ?? "").slice("/file/".length)}`, { headers }), renditions)
    response.writeHead(answer.status, Object.fromEntries(answer.headers))
    if (!answer.body) return void response.end()
    // SAFETY: a fetch body is the runtime's own web ReadableStream; only the DOM and Node typings differ.
    Readable.fromWeb(answer.body as import("node:stream/web").ReadableStream<Uint8Array>).pipe(response)
  })().catch((error: Error) => {
    if (!response.headersSent) response.writeHead(500)
    response.end(error.message)
  })
})
server.listen(socket, () => process.stdout.write("ready\n"))
