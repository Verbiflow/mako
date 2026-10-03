import { net, protocol } from "electron"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { DESK_SCHEME, deskFile } from "./desk-scheme.js"
import { deskPreviewFile } from "./desk-preview-url.js"

/**
 * The request handler for `mako-app://desk/<path>`: the file at `<path>`
 * under the renderer bundle, through Electron's own file loader so types,
 * ranges and `app.asar` behave exactly as `loadFile` did. A path that
 * escapes the bundle, another host, or a missing file is a plain 404. The
 * reserved preview route delegates authorization, ranges and cancellation to
 * the same owner as `mako-file`; it never resolves a filesystem path itself.
 */
export function deskFileHandler(dist: string, preview?: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  const root = resolve(dist)
  return async (request) => {
    const previewUrl = deskPreviewFile(request.url)
    if (previewUrl) {
      if (!preview) return new Response("Not found", { status: 404 })
      return preview(new Request(previewUrl, { method: request.method, headers: request.headers, signal: request.signal }))
    }
    const file = deskFile(root, request.url)
    if (!file) return new Response("Not found", { status: 404 })
    try {
      return await net.fetch(pathToFileURL(file).href)
    } catch {
      return new Response("Not found", { status: 404 })
    }
  }
}

/** Serve the renderer bundle at `dist` on the desk scheme; call once `app` is ready. */
export function serveDesk(dist: string, preview: (request: Request) => Promise<Response>): void {
  protocol.handle(DESK_SCHEME, deskFileHandler(dist, preview))
}
