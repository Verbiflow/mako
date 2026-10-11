import { statSync } from "node:fs"
import { join } from "node:path"
import { hostWarn } from "../base/host-log.js"
import type { LiveSessionState } from "../contracts/providers-acp.js"
import type { SessionFacts, SessionMemory } from "../threads/index.js"

/**
 * Keep the per-user ledger in step with what a connected session reports:
 * its native identity is held while it is connected, and its settings and
 * access mode are recorded whenever they change, so another host — or this
 * one after a restart without its journal — reads the same facts.
 */
export function syncMemory(memory: SessionMemory | undefined, previous: LiveSessionState, next: LiveSessionState): void {
  if (!memory) return
  try {
    const heldId = previous.connection === "connected" ? previous.nativeId : undefined
    const wasHeld = heldId !== undefined
    if (heldId !== undefined && heldId !== next.nativeId)
      memory.release(previous.harness, heldId, next.id)
    if (!next.nativeId) return
    if (next.connection !== "connected") {
      memory.release(next.harness, next.nativeId, next.id)
      return
    }
    if (!memory.owns(next.harness, next.nativeId, next.id))
      memory.hold(next.harness, next.nativeId, next.id)
    const fresh = !wasHeld || previous.nativeId !== next.nativeId
    const settingsChanged =
      JSON.stringify(previous.settings ?? null) !== JSON.stringify(next.settings ?? null)
    const modeChanged = previous.currentMode !== next.currentMode
    // A session without modes reports null; that is nothing to remember,
    // not a request to forget the tier its last session ran under.
    if (fresh || settingsChanged || modeChanged)
      memory.remember(next.harness, next.nativeId, {
        settings: fresh || settingsChanged ? next.settings : undefined,
        modeId: (fresh || modeChanged) && next.currentMode !== null ? next.currentMode : undefined,
      })
  } catch (error) {
    hostWarn("memory", "ledger update failed", {
      conversation: next.id,
      harness: next.harness,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * A journal written before the ledger existed is this host's only record of
 * what its sessions ran under; another host serving the same store had
 * nothing. Each host offers its journals to the ledger once at start,
 * stamped with the journal's write time so a newer observation stays.
 */
export function backfillMemory(memory: SessionMemory | undefined, root: string, id: string, session: LiveSessionState): void {
  if (!memory || !session.nativeId) return
  if (!session.settings && session.currentMode === null) return
  try {
    const facts: SessionFacts = {}
    if (session.settings) facts.settings = session.settings
    if (session.currentMode !== null) facts.modeId = session.currentMode
    // Recent writes sit in the WAL while the main file's mtime stays put.
    const file = join(root, `${id}.sqlite`)
    const wal = statSync(`${file}-wal`, { throwIfNoEntry: false })
    const at = Math.max(statSync(file).mtimeMs, wal?.mtimeMs ?? 0)
    memory.backfill(session.harness, session.nativeId, facts, at)
  } catch (error) {
    hostWarn("memory", "journal backfill failed", {
      conversation: id,
      harness: session.harness,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Let go of a native session's hold in the ledger, so another host may open it. */
export function releaseHold(memory: SessionMemory | undefined, provider: string, nativeId: string, conversationId: string): void {
  try {
    memory?.release(provider, nativeId, conversationId)
  } catch (error) {
    hostWarn("memory", "release failed", { harness: provider, error: error instanceof Error ? error.message : String(error) })
  }
}
