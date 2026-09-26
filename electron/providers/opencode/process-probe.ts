import { processIdentityMatches } from "../process-liveness.js"
import { open, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type {
  ProviderActivitySession,
  ProviderProcessProbe,
} from "../process-probe.js"

const registration = z.object({
  url: z.string().url(),
  pid: z.number().int().positive(),
  version: z.string().optional(),
  password: z.string().max(4096).optional(),
})
const health = z.object({
  healthy: z.literal(true),
  pid: z.number().int().positive(),
  version: z.string(),
})
const running = z.object({
  data: z.record(
    z.string().regex(/^ses/).max(160),
    z.object({ type: z.literal("running") })
  ),
})

/** Registration credentials stay in this provider-owned reader. Never launch a service to observe it. */
async function readRegistration(path: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const file = await open(path, "r")
  try {
    const buffer = Buffer.alloc(64 * 1024 + 1)
    const { bytesRead } = await file.read(buffer)
    if (bytesRead > 64 * 1024)
      throw new Error("OpenCode service registration exceeds the read limit")
    return registration.parse(
      JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"))
    )
  } finally {
    await file.close()
  }
}

async function responseText(
  url: URL,
  headers: Headers,
  signal: AbortSignal
): Promise<string> {
  const response = await fetch(url, { headers, signal, redirect: "error" })
  if (!response.ok || !response.body)
    throw new Error("OpenCode activity is unavailable")
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > 512 * 1024)
      throw new Error("OpenCode activity exceeds the read limit")
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

async function serviceActivity(
  path: string,
  signal: AbortSignal
): Promise<ProviderActivitySession[]> {
  const info = await readRegistration(path, signal)
  // Native service registrations can outlive their process. A dead PID is
  // stale evidence; permission failures and live identity mismatches remain unknown.
  if (!(await processIdentityMatches({ pid: info.pid, signal }))) return []
  const endpoint = new URL(info.url)
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password
  )
    throw new Error("OpenCode activity requires a local service")
  const headers = new Headers()
  if (info.password !== undefined)
    headers.set(
      "Authorization",
      `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}`
    )
  const live = health.parse(
    JSON.parse(
      await responseText(new URL("/api/health", endpoint), headers, signal)
    )
  )
  if (
    live.pid !== info.pid ||
    (info.version !== undefined && live.version !== info.version)
  )
    throw new Error("OpenCode service registration is stale")
  const active = running.parse(
    JSON.parse(
      await responseText(
        new URL("/api/session/active", endpoint),
        headers,
        signal
      )
    )
  )
  return Object.keys(active.data).map((nativeId) => ({
    nativeId,
    status: "active",
  }))
}

export function openCodeProcessProbeFor(
  stateRoot = join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "opencode"
  )
): ProviderProcessProbe {
  return {
    provider: "opencode",
    pollIntervalMs: 3_000,
    timeoutMs: 4_000,
    staleAfterMs: 10_000,
    async probe(signal) {
      try {
        let files: string[]
        try {
          files = (await readdir(stateRoot)).filter((name) =>
            /^service(?:-[a-zA-Z0-9._-]+)?\.json$/.test(name)
          )
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            files = []
          else throw error
        }
        if (files.length > 16)
          throw new Error("Too many OpenCode services to poll")
        const sessions: ProviderActivitySession[] = []
        for (let offset = 0; offset < files.length; offset += 4) {
          const batch = await Promise.all(
            files
              .slice(offset, offset + 4)
              .map((file) => serviceActivity(join(stateRoot, file), signal))
          )
          sessions.push(...batch.flat())
        }
        return { kind: "available", sessions }
      } catch {
        return {
          kind: "unavailable",
          reason: signal.aborted ? "timeout" : "failed",
        }
      }
    },
  }
}

export const openCodeProcessProbe = openCodeProcessProbeFor()
