import { stat } from "node:fs/promises"
import type { AgentHost } from "./agent-host.js"
import { fileIdentity, verifyFilePreview } from "./file-previews.js"
import { fileResponse, localFile } from "./file-response.js"
import type { MediaRenditions } from "./media-renditions.js"
import { workspacePreviewPath } from "./preview-path.js"

/**
 * The two ways the host reads a `mako-file://` URL, kept apart on purpose:
 *
 * - `readSignedFile` serves only a file whose signed URL this host issued (`mako-file://asset/…`, `file-previews.ts`).
 *   It is what reaches the account's other devices and cloud machines through the gateway (`PortRelay`).
 * - `readWindowFile` serves that, and also a path in the window's open workspace (`mako-file://workspace/…`), with
 *   absolute paths allowed: the desktop window and the browser gateways on this Mac's socket, which already act as the
 *   person on it. Never hand it to the gateway: anything that can reach it can read any file the person can.
 */

/** A signed file, or a smaller picture of it (`?rendition=poster|thumbnail`); anything else is not found. */
export async function readSignedFile(request: Request, renditions: MediaRenditions): Promise<Response> {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 })
  const grant = await verifyFilePreview(request.url)
  if (grant.kind === "refused") return new Response(`Refused: ${grant.reason}`, { status: 403 })
  if (grant.kind === "invalid") return new Response("Not found", { status: 404 })
  // A thumbnail that can't be made is the file itself.
  const kind = new URL(request.url).searchParams.get("rendition")
  if (grant.entry && (kind === "poster" || kind === "thumbnail")) {
    const info = await stat(grant.path)
    const made = await renditions.rendition(grant.path, fileIdentity(info), kind)
    if (made) return fileResponse(await localFile(made, request.signal), made, request, { cacheable: true })
    if (kind === "poster") return new Response("No poster", { status: 404 })
  }
  return fileResponse(await localFile(grant.path, request.signal), grant.path, request, { cacheable: true, crossOrigin: !grant.entry })
}

/** What the desktop window reads: a signed file, or else a path its open workspace resolves. Never the gateway's. */
export async function readWindowFile(request: Request, withHost: <T>(run: (host: Pick<AgentHost, "resolvePath">) => T | Promise<T>) => Promise<T>, renditions: MediaRenditions): Promise<Response> {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 })
  const path = workspacePreviewPath(request.url)
  if (!path) return readSignedFile(request, renditions)
  try {
    return await withHost(async (host) => {
      const absolute = await host.resolvePath(path)
      return fileResponse(await localFile(absolute, request.signal), absolute, request)
    })
  } catch {
    return new Response("Not found", { status: 404 })
  }
}
