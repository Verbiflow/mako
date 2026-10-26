import { fileContentType } from "./file-media.js"
import { fitPage } from "../base/file-policy.js"
import { createReadStream } from "node:fs"
import { open, readFile, stat } from "node:fs/promises"
import { Readable } from "node:stream"

/** The largest page fitted to its frame; a larger one is served as it is and scrolls inside it. */
const FITTED_PAGE_LIMIT = 16 * 1024 * 1024

/** The whole file at `path`, as a fetch of its file URL answers; a missing file or a folder throws. */
export async function localFile(path: string, signal?: AbortSignal): Promise<Response> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`Not a file: ${path}`)
  // SAFETY: `Readable.toWeb` returns the runtime's own ReadableStream; only
  // the typings differ when DOM and Node declarations are both loaded.
  const body = Readable.toWeb(createReadStream(path, { signal })) as ReadableStream<Uint8Array>
  return new Response(body, { headers: { "content-length": String(info.size) } })
}

/**
 * Serve requested bytes from the authorized file; the source answers the
 * whole file. A page also reports its height to the frame showing it; what
 * it may do there is the route's `filePolicyHeaders`. `cacheable`: the URL
 * names this version of the file, so the renderer may keep what it loaded
 * instead of asking again on every mount. `crossOrigin`: an asset of a
 * sandboxed page, whose opaque origin needs CORS to load its fonts and
 * module scripts; its URL is the capability.
 */
export async function fileResponse(
  source: Response,
  path: string,
  request: Request,
  options: { cacheable?: boolean; crossOrigin?: boolean } = {}
): Promise<Response> {
  const headers = new Headers(source.headers)
  headers.set("accept-ranges", "bytes")
  let mime: string | undefined
  const prefixFile = await open(path, "r")
  try {
    const prefix = Buffer.alloc(4096)
    const { bytesRead } = await prefixFile.read(prefix, 0, prefix.length, 0)
    mime = await fileContentType(path, prefix.subarray(0, bytesRead))
    if (mime) headers.set("content-type", mime)
  } finally {
    await prefixFile.close()
  }
  if (options.cacheable && !/^(?:video|audio)\//.test(mime ?? "")) headers.set("cache-control", "private, max-age=3600")
  if (options.crossOrigin) headers.set("access-control-allow-origin", "*")
  if (mime === "text/html" && Number(headers.get("content-length")) <= FITTED_PAGE_LIMIT) {
    await source.body?.cancel()
    const page = fitPage(await readFile(path))
    headers.set("content-length", String(page.length))
    headers.delete("accept-ranges")
    return new Response(new Uint8Array(page), { status: 200, headers })
  }
  const range = request.headers.get("range")
  if (!range)
    return new Response(source.body, { status: source.status, headers })
  await source.body?.cancel()
  const file = await open(path, "r")
  try {
    const { size } = await file.stat()
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    const start = match?.[1]
      ? Number(match[1])
      : Math.max(0, size - Number(match?.[2]))
    const end =
      match?.[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1
    if (
      !match ||
      (!match[1] && !match[2]) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= size ||
      end < start
    ) {
      await file.close()
      return new Response(null, {
        status: 416,
        headers: {
          "content-range": `bytes */${size}`,
          "accept-ranges": "bytes",
        },
      })
    }
    headers.set("content-range", `bytes ${start}-${end}/${size}`)
    headers.set("content-length", String(end - start + 1))
    const stream = file.createReadStream({
      start,
      end,
      autoClose: true,
      signal: request.signal,
    })
    // SAFETY: `Readable.toWeb` returns the runtime's own ReadableStream; only
    // the typings differ when DOM and Node declarations are both loaded.
    const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>
    return new Response(body, { status: 206, headers })
  } catch (error) {
    await file.close()
    throw error
  }
}
