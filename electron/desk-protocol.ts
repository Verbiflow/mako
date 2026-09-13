import { net, protocol } from "electron"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { DESK_SCHEME, deskFile } from "./desk-scheme.js"

/**
 * The request handler for `mako-app://desk/<path>`: the file at `<path>`
 * under the renderer bundle, through Electron's own file loader so types,
 * ranges and `app.asar` behave exactly as `loadFile` did. A path that
 * escapes the bundle, another host, or a missing file is a plain 404; the
 * handler never throws into the network stack.
 */
export function deskFileHandler(dist: string): (request: Request) => Promise<Response> {
  const root = resolve(dist)
  return async (request) => {
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
export function serveDesk(dist: string): void {
  protocol.handle(DESK_SCHEME, deskFileHandler(dist))
}
