import { Uint8ArrayReader, ZipReader } from "@zip.js/zip.js"

export const OFFICE_BYTE_LIMIT = 16 * 1024 * 1024
const expandedLimit = 32 * 1024 * 1024

/** Read a private file without allowing a server to bypass the declared budget. */
export async function readOfficeInput(
  url: string,
  signal: AbortSignal
): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`File request failed (${response.status})`)
  const tooLarge = () =>
    new Error(
      "This document exceeds the 16 MB inline preview limit. Open the original in your editor."
    )
  if (Number(response.headers.get("content-length")) > OFFICE_BYTE_LIMIT) {
    await response.body?.cancel()
    throw tooLarge()
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error("This document cannot be streamed")
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > OFFICE_BYTE_LIMIT) throw tooLarge()
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const buffer = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    buffer.set(chunk, offset)
    offset += chunk.byteLength
  }
  await checkOfficeArchive(buffer, signal)
  return buffer.buffer
}

/** Inspect ZIP metadata before starting the document engines; do not decompress. */
export async function checkOfficeArchive(
  bytes: Uint8Array,
  signal: AbortSignal
): Promise<void> {
  const reader = new ZipReader(new Uint8ArrayReader(bytes), {
    useWebWorkers: false,
  })
  let count = 0,
    expanded = 0
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      signal.throwIfAborted()
      expanded += entry.uncompressedSize
      if (
        ++count > 2048 ||
        expanded > expandedLimit ||
        entry.uncompressedSize > 8 * 1024 * 1024
      )
        throw new Error(
          "This document is too complex for an inline preview. Open the original in your editor."
        )
      if (entry.encrypted)
        throw new Error("This document is encrypted. Open it in your editor.")
    }
  } finally {
    await reader.close()
  }
}
