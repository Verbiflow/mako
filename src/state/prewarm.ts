import { getMako } from "@/lib/bridge"
import { acpStore, activeAcp, activeLiveAcp } from "@/state/acp"
import { store as sessionStore } from "@/state/session"
import { openSessionDraft, threadGroupsStore } from "@/state/thread-groups"
import { runPlaceStore } from "@/state/run-place"

/** One signal per conversation or folder per window: enough to wake it, or to restart its idle timer during a long draft. */
const PREWARM_EVERY_MS = 30_000
const signalled = new Map<string, number>()
/** A draft this long reads as a message being written, not a stray key: only then is a cloud Thread made ahead. */
const CLOUD_PREPARE_FROM_CHARS = 8
/** Asked to write more first, the composer asks again this much later. */
const CLOUD_LATER_MS = 2_000
/** When the new Thread's draft got its first text, by folder: how long the person has been writing it. */
const composingSince = new Map<string, number>()

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
  if (!text.trim()) {
    // Nothing written: the next draft is timed from its own first key.
    composingSince.clear()
    return
  }
  const acpState = acpStore.get()
  const live = activeLiveAcp(acpState)
  if (live) {
    if (live.session.status === "closed" || !due(live.key, now)) return
    void getMako().livePrewarm(live.key).catch(() => signalled.delete(live.key))
    return
  }
  if (activeAcp(acpState)) return
  const cwd = openSessionDraft(threadGroupsStore.get())?.cwd ?? sessionStore.get().meta?.cwd
  if (!cwd) return
  if (runPlaceStore.get().cloud) return prepareCloud(cwd, text, now)
  const key = `folder\0${cwd}`
  if (!due(key, now)) return
  void getMako().launchPrewarm(cwd).catch(() => signalled.delete(key))
}

/**
 * Writing a new Thread's first message with Cloud chosen: once it reads like a message, its cloud Thread is made
 * ahead, so its machine starts and clones while the person writes, and asking again as they go on keeps it running.
 * Choosing Cloud makes nothing; writing does. The draft itself never leaves this Mac before it's sent.
 */
function prepareCloud(cwd: string, text: string, now: number): void {
  const began = composingSince.get(cwd) ?? now
  composingSince.set(cwd, began)
  const key = `cloud\0${cwd}`
  if (text.trim().length < CLOUD_PREPARE_FROM_CHARS || !due(key, now)) return
  void getMako().cloudPrepare(cwd, now - began).then(
    (outcome) => {
      if (outcome === "later") signalled.set(key, now - PREWARM_EVERY_MS + CLOUD_LATER_MS)
    },
    () => signalled.delete(key)
  )
}
