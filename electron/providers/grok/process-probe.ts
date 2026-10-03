import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { processIdentityMatches } from "../process-liveness.js"
import type {
  ProviderActivitySession,
  ProviderProcessProbe,
} from "../process-probe.js"

const MAX_REGISTRY_BYTES = 1024 * 1024
const GrokActiveSessionSchema = z.object({
  session_id: z.string().min(1).max(160).optional(),
  sessionId: z.string().min(1).max(160).optional(),
  id: z.string().min(1).max(160).optional(),
  opened_at: z.union([z.number(), z.string()]).optional(),
  openedAt: z.union([z.number(), z.string()]).optional(),
  pid: z.number().int().positive(),
})
const GrokActiveSessionsSchema = z.array(GrokActiveSessionSchema).max(4_096)

export function parseGrokActiveSessions<Value>(
  value: Value,
  isAlive: (pid: number) => boolean
): ProviderActivitySession[] {
  return GrokActiveSessionsSchema.parse(value).flatMap((session) => {
    const nativeId = session.session_id ?? session.sessionId ?? session.id
    return nativeId && isAlive(session.pid)
      ? [{ nativeId, status: "open" } satisfies ProviderActivitySession]
      : []
  })
}

async function validatedSessions<Value>(
  value: Value,
  signal: AbortSignal
): Promise<ProviderActivitySession[]> {
  const active: ProviderActivitySession[] = []
  for (const session of GrokActiveSessionsSchema.parse(value)) {
    const nativeId = session.session_id ?? session.sessionId ?? session.id
    if (!nativeId) throw new Error("Grok activity record has no session identity")
    if (
      nativeId &&
      (await processIdentityMatches({
        pid: session.pid,
        startedAt: session.opened_at ?? session.openedAt,
        signal,
      }))
    )
      active.push({ nativeId, status: "open" })
  }
  return active
}

function grokHome(): string {
  return process.env.GROK_HOME ?? join(homedir(), ".grok")
}

export const grokProcessProbe: ProviderProcessProbe = {
  provider: "grok",
  pollIntervalMs: 3_000,
  staleAfterMs: 10_000,
  async probe(signal, target) {
    const marker = target?.path.lastIndexOf("/sessions/") ?? -1
    if (target && marker < 0) return { kind: "unavailable", reason: "unsupported" }
    const root = target && marker > 0 ? target.path.slice(0, marker) : grokHome()
    const path = join(root, "active_sessions.json")
    let info
    try {
      info = await stat(path)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { kind: "available", sessions: [] }
      return { kind: "unavailable", reason: "failed" }
    }
    if (info.size > MAX_REGISTRY_BYTES)
      return { kind: "unavailable", reason: "failed" }
    try {
      return {
        kind: "available",
        sessions: await validatedSessions(
          JSON.parse(await readFile(path, { encoding: "utf8", signal })),
          signal
        ),
      }
    } catch {
      return { kind: "unavailable", reason: "failed" }
    }
  },
}
