import { acpStore } from "@/state/acp-state"
import { unloadLive } from "@/state/live-recovery"
import { tabFor } from "@/state/session-panes"
import { viewerStore } from "@/state/viewer"

/**
 * Conversations kept loaded besides the one on screen, most recently shown
 * first, so going back and forth between a few is instant.
 *
 * Every other conversation goes back to how boot listed it. Without this the
 * window kept the transcript of every conversation opened since it started:
 * a few days of long agent sessions, each tens of megabytes of blocks, is a
 * heap of gigabytes whose collection pauses land under typing.
 */
const KEPT_RECENT = 2

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

/** Unload what nothing reads each time the active conversation changes. */
export function watchLiveResidency(): () => void {
  let recent: string[] = []
  let active = acpStore.get().activeKey
  const settle = () => {
    const next = acpStore.get().activeKey
    if (next === active) return
    if (active) recent = [active, ...recent.filter((key) => key !== active)].slice(0, KEPT_RECENT)
    active = next
    const kept = inUse()
    for (const key of recent) kept.add(key)
    if (active) kept.add(active)
    for (const conversation of Object.values(acpStore.get().conversations))
      if (conversation.hydrated && !kept.has(conversation.key)) unloadLive(conversation.key)
  }
  return acpStore.subscribe(settle)
}
