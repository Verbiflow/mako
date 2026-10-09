import { getMako } from "@/lib/bridge"
import { acpStore, activeAcp, activeLiveAcp } from "@/state/acp"
import { store as sessionStore } from "@/state/session"
import { openSessionDraft, threadGroupsStore } from "@/state/thread-groups"

/** One signal per conversation or folder per window: enough to wake it, or to restart its idle timer during a long draft. */
const PREWARM_EVERY_MS = 30_000
const signalled = new Map<string, number>()

function due(key: string, now: number): boolean {
  if (now - (signalled.get(key) ?? Number.NEGATIVE_INFINITY) < PREWARM_EVERY_MS) return false
  signalled.set(key, now)
  return true
}

/**
 * Writing to the active live conversation wakes it on its host, and writing a new
 * conversation's first message prepares its launch, so either overlaps the typing
 * instead of following Send.
 */
export function noteComposing(text: string, now = Date.now()): void {
  if (!text.trim()) return
  const acpState = acpStore.get()
  const live = activeLiveAcp(acpState)
  if (live) {
    if (live.session.status === "closed" || !due(live.key, now)) return
    void getMako().livePrewarm(live.key).catch(() => signalled.delete(live.key))
    return
  }
  if (activeAcp(acpState)) return
  const cwd = openSessionDraft(threadGroupsStore.get())?.cwd ?? sessionStore.get().meta?.cwd
  const key = `folder\0${cwd}`
  if (!cwd || !due(key, now)) return
  void getMako().launchPrewarm(cwd).catch(() => signalled.delete(key))
}
