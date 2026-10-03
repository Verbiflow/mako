import { DIAGNOSTIC_BYTE_LIMIT } from "./diagnostic-summary"

export async function readDiagnosticInput(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`File request failed (${response.status})`)
  if (Number(response.headers.get("content-length")) > DIAGNOSTIC_BYTE_LIMIT) {
    await response.body?.cancel()
    throw new Error(
      "This file exceeds the 32 MB inspection limit. Open the original in a dedicated profiler."
    )
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error("This file cannot be streamed")
  const decoder = new TextDecoder("utf-8", { fatal: true }),
    chunks: string[] = []
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > DIAGNOSTIC_BYTE_LIMIT)
        throw new Error(
          "This file exceeds the 32 MB inspection limit. Open the original in a dedicated profiler."
        )
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join("")
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}
