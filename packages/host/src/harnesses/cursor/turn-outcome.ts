import { cursorSdkAgentIdForDirectory, cursorSdkIndexPath, cursorStoreOrigin } from "@mako/sessions"
import type { NativeStores } from "@mako/sessions/read-only-sqlite"
import type { NativeTurnReader } from "../native-turn.js"

/** The SDK run ID is scoped by both the agent row and the source directory. */
export function cursorTurnReader(stores: NativeStores, stateRoot: () => string, home: string): NativeTurnReader {
  return async ({ binding, runId }) => {
    const unknown = { kind: "unknown" as const, reason: "The native source was read, but this run has no unambiguous outcome." }
    const unavailable = { kind: "unavailable" as const, reason: "The exact native run could not be read from its saved store." }
    if (!binding.path || !binding.nativeId) return unavailable
    const origin = cursorStoreOrigin(binding.path, { stateRoot: stateRoot(), home })
    if (!origin) return unavailable
    if (origin.origin !== "sdk") return origin.sessionId === binding.nativeId ? unknown : unavailable
    const index = cursorSdkIndexPath(stateRoot())
    if (cursorSdkAgentIdForDirectory(stores, index, origin.directoryName) !== binding.nativeId) return unavailable
    try {
      const database = stores.open(index)
      try {
        const run = database.prepare(`SELECT status, EXISTS (SELECT 1 FROM runs later WHERE later.agent_id=runs.agent_id AND later.turn_number>runs.turn_number) AS newer
          FROM runs WHERE agent_id=? AND run_id=?`).get(binding.nativeId, runId)
        if (!run || run.newer !== 0) return unknown
        if (run.status === "FINISHED") return { kind: "completed" }
        // Native terminal refusals and cancellations are decisions, not a reason to send another turn.
        return run.status === "RUNNING" ? { kind: "unfinished" } : unknown
      } finally { database.close() }
    } catch { return unavailable }
  }
}
