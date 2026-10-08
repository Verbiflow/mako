import { acpStore } from "@/state/acp-state"
import { unloadLive } from "@/state/live-recovery"
import { tabFor } from "@/state/session-panes"
import { viewerStore } from "@/state/viewer"
import { liveReadingSource, transcriptReaders } from "@/state/transcript-reading"
import { historyTurns, releaseBlocks, releaseEntries } from "@/state/transcript-residency"
import { projectAcp } from "@/state/live-projection"
import { replaceAcpConversation } from "@/state/acp-state"
import { subscribeThreadCache, sweepThreadResidency } from "@/state/thread-viewing"
import { liveToolFinished } from "@mako/sessions/live-content"
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
  for (const source of transcriptReaders.heldSources()) if (source.startsWith("live:")) keys.add(source.slice(5))
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
    sweepThreadResidency()
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
    // Whole inactive conversations go first. If their removal was insufficient,
    // release finished cold turns inside the conversations the panes still read.
    let bytes = Object.values(acpStore.get().conversations).reduce((total, conversation) => total +
      (conversation.hydrated ? liveContentWeight(conversation) : 0), 0)
    if (bytes > budget.bytes) {
      const cold = []
      for (const conversation of Object.values(acpStore.get().conversations)) {
        if (conversation.kind !== "live" || !conversation.hydrated || !conversation.history?.ranges) continue
        const source = liveReadingSource(conversation.key)
        const protectedTurns = transcriptReaders.protected(source)
        // No mounted timeline for a pinned/operational conversation is not
        // evidence that its in-flight inputs can be discarded.
        if (!protectedTurns || (pinned.has(conversation.key) && !transcriptReaders.sources().has(source))) continue
        const projection = projectAcp(conversation)
        const operating = new Set(conversation.requests?.filter(request =>
          ["dispatching", "queued", "held"].includes(request.status)).map(request => `acp-request-${request.id}`))
        for (const turn of historyTurns(projection.exchanges, conversation.blocks, conversation.history.blockStart,
          conversation.base?.entries ?? [], conversation.base?.start ?? 0)) {
          if (protectedTurns.has(turn.id) || operating.has(turn.id) || transcriptReaders.warm(source, turn.id) ||
              conversation.blocks.slice(turn.blocks.start - conversation.history.blockStart, turn.blocks.end - conversation.history.blockStart)
                .some(block => block.type === "tool" && !liveToolFinished(block.status))) continue
          const weight = liveContentWeight({
            blocks: conversation.blocks.slice(turn.blocks.start - conversation.history.blockStart, turn.blocks.end - conversation.history.blockStart),
            base: conversation.base ? { ...conversation.base, entries: conversation.base.entries.slice(
              turn.base.start - conversation.base.start, turn.base.end - conversation.base.start) } : null,
          })
          cold.push({ key: conversation.key, turn, weight, used: transcriptReaders.usedAt(source, turn.id) })
        }
      }
      cold.sort((left, right) => left.used - right.used || right.weight - left.weight)
      const releases = new Map<string, typeof cold>()
      for (const candidate of cold) {
        if (bytes <= budget.bytes) break
        const held = releases.get(candidate.key) ?? []
        held.push(candidate)
        releases.set(candidate.key, held)
        bytes -= Math.max(0, candidate.weight - 1024)
      }
      for (const [key, turns] of releases) {
        const current = acpStore.get().conversations[key]
        if (current?.kind !== "live" || !current.history) continue
        const ranges = turns.map(item => item.turn)
        const blocks = releaseBlocks(current.blocks, current.history.blockStart, ranges)
        const base = current.base ? { ...current.base, entries: releaseEntries(current.base.entries, current.base.start, ranges) } : current.base
        const next = { ...current, blocks, base, releasedTurns: [...(current.releasedTurns ?? []), ...turns.map(item => item.turn)] }
        replaceAcpConversation(key, { ...next, projection: projectAcp(next) })
      }
    }
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
  const unsubscribeReaders = transcriptReaders.subscribe(settle)
  const unsubscribeHistory = subscribeThreadCache(settle)
  settle()
  return () => {
    stopped = true
    unsubscribe()
    unsubscribePanes()
    unsubscribeReaders()
    unsubscribeHistory()
  }
}
