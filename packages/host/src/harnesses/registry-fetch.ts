import { z } from "zod"

/**
 * One bounded read of a public registry: a short deadline, and a body read in
 * chunks and refused past `limit`, so a slow or oversized answer never holds
 * a reading. Every public reading the host takes goes through it: a
 * runtime's newest version (`RuntimeUpdates`) and its release dates
 * (`ReleaseTimelines`).
 */

export const REGISTRY_TIMEOUT_MS = 4_000

export async function registryJson<T>(url: string, schema: z.ZodType<T>, options: { limit: number; headers?: Record<string, string>; what: string }): Promise<T> {
  const response = await fetch(url, { headers: options.headers ?? { accept: "application/json" }, signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`${options.what} answered ${response.status}`)
  if (Number(response.headers.get("content-length") ?? 0) > options.limit) throw new Error(`${options.what} answer too large`)
  const reader = response.body?.getReader()
  if (!reader) throw new Error(`${options.what} returned no body`)
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.length
      if (bytes > options.limit) throw new Error(`${options.what} answer too large`)
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const parsed = schema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")))
  if (!parsed.success) throw new Error(`${options.what} answered in a shape Mako doesn't read`)
  return parsed.data
}
