import { acpStore } from "@/state/acp-state"
import { unloadLive } from "@/state/live-recovery"
import { tabFor } from "@/state/session-panes"
import { viewerStore } from "@/state/viewer"
import { liveContentWeight, residencyPlan, type ResidencyBudget } from "../../electron/contracts/residency"

/**
 * What this window holds of conversations off screen; see `ResidencyBudget`.
 * The rest go back to how boot listed them and read again when opened.
 *
 * Without a bound the window kept the transcript of every conversation opened
 * since it started: a few days of long agent sessions, each tens of megabytes
 * of blocks, is a heap of gigabytes whose collection pauses land under typing.
 * The projection a shown conversation renders adds about as much again as its
 * blocks weigh, which this budget leaves room for.
 */
export const WINDOW_MEMORY: ResidencyBudget = { bytes: 64 * 1024 * 1024, recent: 2 }

/** Conversations whose transcript something on screen or in flight still reads. */
function inUse(): Set<string> {
  const keys = new Set<string>()
  for (const pane of viewerStore.get().panes) {
    const tab = pane.session ? tabFor(pane.session) : undefined
    if (tab?.kind === "session" && tab.presence) keys.add(tab.presence.key)
  }
  for (const conversation of Object.values(acpStore.get().conversations))
    if (
      conversation.kind === "starting" ||
      conversation.session.status === "running" ||
      conversation.session.status === "starting" ||
      conversation.permission ||
      conversation.sending ||
      conversation.pendingPrompts?.length
    )
      keys.add(conversation.key)
  return keys
}

/** Runs `work` when the window next has nothing to do, so a switch never pays for unloading. */
function whenIdle(work: () => void): void {
  if (globalThis.requestIdleCallback) globalThis.requestIdleCallback(work, { timeout: 2_000 })
  else setTimeout(work, 0)
}

/** Reconsider residency when content, activity, or the visible panes change. */
export function watchLiveResidency(budget = WINDOW_MEMORY): () => void {
  /** In what order each conversation was last on screen; the one shown now is pinned instead. */
  const shownAt = new Map<string, number>()
  let shown = 0
  let active = acpStore.get().activeKey
  let scheduled = false
  let stopped = false
  const sweep = () => {
    scheduled = false
    if (stopped) return
    const pinned = inUse()
    if (active) pinned.add(active)
    const candidates = []
    for (const conversation of Object.values(acpStore.get().conversations)) {
      if (!conversation.hydrated) continue
      candidates.push({
        id: conversation.key,
        usedAt: shownAt.get(conversation.key) ?? 0,
        weight: liveContentWeight({ blocks: conversation.blocks, base: conversation.base, requests: conversation.requests }),
        pinned: pinned.has(conversation.key),
      })
    }
    for (const key of residencyPlan(candidates, budget).evict) unloadLive(key)
    for (const key of shownAt.keys()) if (!acpStore.get().conversations[key]) shownAt.delete(key)
  }
  const settle = () => {
    const next = acpStore.get().activeKey
    if (next !== active) {
      if (active) shownAt.set(active, ++shown)
      active = next
    }
    if (scheduled) return
    scheduled = true
    whenIdle(sweep)
  }
  const unsubscribe = acpStore.subscribe(settle)
  const unsubscribePanes = viewerStore.subscribe(settle)
  settle()
  return () => {
    stopped = true
    unsubscribe()
    unsubscribePanes()
  }
}
