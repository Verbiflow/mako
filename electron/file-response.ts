import { fileContentType } from "./file-media.js"
import { open } from "node:fs/promises"
import { Readable } from "node:stream"

/** Electron's file fetch ignores Range; serve requested bytes from the authorized file. */
export async function fileResponse(
  source: Response,
  path: string,
  request: Request
): Promise<Response> {
  const headers = new Headers(source.headers)
  headers.set("accept-ranges", "bytes")
  const prefixFile = await open(path, "r")
  try {
    const prefix = Buffer.alloc(4096)
    const { bytesRead } = await prefixFile.read(prefix, 0, prefix.length, 0)
    const mime = await fileContentType(path, prefix.subarray(0, bytesRead))
    if (mime) headers.set("content-type", mime)
  } finally {
    await prefixFile.close()
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
    return new Response(Readable.toWeb(stream), { status: 206, headers })
  } catch (error) {
    await file.close()
    throw error
  }
}
