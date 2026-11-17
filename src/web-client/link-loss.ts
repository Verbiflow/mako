import { useEffect } from "react"
import { RECONNECT_QUIET_MS, RESTART_AFTER_MS, reconnectStageRank, type ReconnectStage } from "@/lib/reconnect-stages"
import { acpStore, type AcpState } from "@/state/acp-state"
import { createHook, createStore } from "@/state/store"

/**
 * This browser's link to Mako, lost since `since`, at its stage: one loss for the whole page, as the desk keeps one for
 * its window (`hostDisconnected`), so opening another Thread mid-outage goes on at the stage the loss reached rather
 * than at quiet again. A loss is the browser offline, or any conversation's message whose answer was lost on the way
 * (`unconfirmed`, asked again under its ID); it ends once neither holds.
 */
type LinkLoss = { since: number; stage: ReconnectStage } | { since: undefined; stage: undefined }

export const linkLossStore = createStore<LinkLoss>({ since: undefined, stage: undefined })
const useLinkLoss = createHook(linkLossStore)

/** Whether any conversation this page holds has a message whose answer was lost on the way. */
export function anyUnconfirmed(state: { conversations: Readonly<Record<string, { kind: string; pendingPrompts?: readonly { unconfirmed?: boolean }[] }>> }): boolean {
  return Object.values(state.conversations).some((conversation) => conversation.kind === "live" && (conversation.pendingPrompts ?? []).some((prompt) => prompt.unconfirmed))
}

/**
 * The loss as it stands after a reading: kept from its first moment while the link stays lost, so a second reading
 * doesn't restart the wait; gone once it's back.
 */
export function nextLoss(held: LinkLoss, lost: boolean, now: number): LinkLoss {
  if (!lost) return { since: undefined, stage: undefined }
  return held.since === undefined ? { since: now, stage: "quiet" } : held
}

/** Reads the link once: sets the loss, and arms each stage's bound for a loss just begun. */
function read(): void {
  const held = linkLossStore.get()
  const next = nextLoss(held, !navigator.onLine || anyUnconfirmed(acpStore.get()), Date.now())
  if (next === held) return
  linkLossStore.set(next)
  const since = next.since
  if (since === undefined) return
  // Each bound moves the same loss on a stage; back meanwhile, or lost again since, says nothing.
  const later = (ms: number, stage: ReconnectStage) =>
    setTimeout(() => {
      const now = linkLossStore.get()
      if (now.since === since && reconnectStageRank(now.stage) < reconnectStageRank(stage)) linkLossStore.set({ since, stage })
    }, ms)
  later(RECONNECT_QUIET_MS, "long")
  later(RESTART_AFTER_MS, "restart")
}

interface Following {
  on: boolean
  /** The conversations last read: a change of the store that keeps them (the active key) reads nothing. */
  conversations?: AcpState["conversations"]
}
const following: Following = { on: false }

/** Follows the link for the page's life, once: the network's changes and the conversations' messages. */
function followLinkLoss(): void {
  if (following.on) return
  following.on = true
  window.addEventListener("online", read)
  window.addEventListener("offline", read)
  // Only a new set of conversations can change what's unconfirmed; the read itself is a scan of their pending messages.
  acpStore.subscribe(() => {
    const conversations = acpStore.get().conversations
    if (conversations === following.conversations) return
    following.conversations = conversations
    read()
  })
  read()
}

/** The page's link loss at its stage (`@/lib/reconnect-stages`), or undefined while the link holds. */
export function useLinkStage(): ReconnectStage | undefined {
  useEffect(followLinkLoss, [])
  return useLinkLoss((state) => state.stage)
}
