import { grokHome } from "@mako/sessions"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { processIdentityMatches } from "../process-liveness.js"
import { probeOpenFiles } from "../open-files-probe.js"
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
): Promise<{ sessions: ProviderActivitySession[]; pids: Set<number> }> {
  const active: ProviderActivitySession[] = []
  const pids = new Set<number>()
  for (const session of GrokActiveSessionsSchema.parse(value)) {
    const nativeId = session.session_id ?? session.sessionId ?? session.id
    if (!nativeId) throw new Error("Grok activity record has no session identity")
    if (
      (await processIdentityMatches({
        pid: session.pid,
        startedAt: session.opened_at ?? session.openedAt,
        signal,
      }))
    ) {
      active.push({ nativeId, status: "open" })
      pids.add(session.pid)
    }
  }
  return { sessions: active, pids }
}

export const grokProcessProbe: ProviderProcessProbe = {
  provider: "grok",
  pollIntervalMs: 3_000,
  staleAfterMs: 10_000,
  async probe(signal, target) {
    const marker = target?.path.lastIndexOf("/sessions/") ?? -1
    if (target && marker < 0) return { kind: "unavailable", reason: "unsupported" }
    const root = target && marker > 0 ? target.path.slice(0, marker) : grokHome(process.env)
    const path = join(root, "active_sessions.json")
    let info
    try {
      info = await stat(path)
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        return { kind: "unavailable", reason: "failed" }
    }
    if (info && info.size > MAX_REGISTRY_BYTES)
      return { kind: "unavailable", reason: "failed" }
    try {
      const registered = info ? await validatedSessions(
          JSON.parse(await readFile(path, { encoding: "utf8", signal })),
          signal
        ) : { sessions: [], pids: new Set<number>() }
      if (!target || registered.sessions.some(session => session.nativeId === target.nativeId))
        return { kind: "available", sessions: registered.sessions }
      // Grok 1.0.44 ACP does not enter active_sessions.json. An absent or
      // empty registry cannot clear a live, unregistered native process.
      // lsof's plain -c is a prefix match: Grok also selects Grok Bot.app.
      // That unrelated desktop executable is not a CLI ownership record.
      // Grok 1.0.44 reports grok in ps but grok-native in lsof's command field.
      const running = await probeOpenFiles({ processNames: ["/^grok$/", "/^grok-native$/", "/^Grok$/"], signal, accept: () => false })
      if (running.kind === "unavailable") return running
      if (running.pids.some(pid => !registered.pids.has(pid)))
        return { kind: "unavailable", reason: "incomplete" }
      return { kind: "available", sessions: registered.sessions }
    } catch {
      return { kind: "unavailable", reason: "failed" }
    }
  },
}
