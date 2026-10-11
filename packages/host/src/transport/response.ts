import type { IncomingMessage } from "node:http"

const RESPONSE_LIMIT = 32 * 1024 * 1024

export class RuntimeResponseLimitError extends Error {
  constructor() {
    super("Mako host response exceeded its byte limit")
    this.name = "RuntimeResponseLimitError"
  }
}

export interface RuntimeTransfer {
  encoding: "identity" | "binary"
  wireBytes: number
  decodedBytes: number
}

/** Current RPC uses identity JSON; previews have their own binary reader.
 * No caller negotiates compression. Unexpected encodings remain uncertain
 * responses, never an empty success or a reason to replay an action. */
export async function readRuntimeResponse(
  response: IncomingMessage
): Promise<RuntimeTransfer & { body: string }> {
  const encoding = response.headers["content-encoding"] ?? "identity"
  if (encoding !== "identity") {
    response.destroy()
    throw new Error("Unsupported Mako host response encoding")
  }
  let wireBytes = 0
  const chunks: Buffer[] = []
  try {
    for await (const chunk of response) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      wireBytes += bytes.length
      if (wireBytes > RESPONSE_LIMIT)
        throw new RuntimeResponseLimitError()
      chunks.push(bytes)
    }
    return {
      body: Buffer.concat(chunks).toString("utf8"),
      encoding,
      wireBytes,
      decodedBytes: wireBytes,
    }
  } finally {
    if (!response.complete) response.destroy()
  }
}
