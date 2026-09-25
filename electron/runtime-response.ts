import type { IncomingMessage } from "node:http"
import { createBrotliDecompress } from "node:zlib"

const RESPONSE_LIMIT = 32 * 1024 * 1024

export class RuntimeResponseLimitError extends Error {
  constructor(kind: "wire" | "decoded") {
    super(`Mako host response exceeded its ${kind} limit`)
    this.name = "RuntimeResponseLimitError"
  }
}

export interface RuntimeTransfer {
  encoding: "identity" | "br" | "binary"
  wireBytes: number
  decodedBytes: number
}

/** Accept bounded legacy Brotli replies during host/client updates. Current
 * preview pixels use the dedicated binary reader. Bound both sides of decompression. A malformed/truncated response is never a
 * successful empty reply; the RPC owner retains its uncertain-outcome handling. */
export async function readRuntimeResponse(
  response: IncomingMessage
): Promise<RuntimeTransfer & { body: string }> {
  const encoding = response.headers["content-encoding"] ?? "identity"
  if (encoding !== "br" && encoding !== "identity") {
    response.destroy()
    throw new Error("Unsupported Mako host response encoding")
  }
  const decoder = encoding === "br" ? createBrotliDecompress() : undefined
  const input = decoder ?? response
  let wireBytes = 0
  const fail = (error: Error) => {
    decoder?.destroy(error)
  }
  response.on("error", fail)
  response.on("data", (chunk: Buffer) => {
    wireBytes += chunk.length
    if (wireBytes > RESPONSE_LIMIT)
      response.destroy(new RuntimeResponseLimitError("wire"))
  })
  if (decoder) response.pipe(decoder)
  const chunks: Buffer[] = []
  let decodedBytes = 0
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      decodedBytes += bytes.length
      if (decodedBytes > RESPONSE_LIMIT)
        throw new RuntimeResponseLimitError("decoded")
      chunks.push(bytes)
    }
    return {
      body: Buffer.concat(chunks).toString("utf8"),
      encoding,
      wireBytes,
      decodedBytes,
    }
  } finally {
    response.off("error", fail)
    decoder?.destroy()
    if (!response.complete) response.destroy()
  }
}
