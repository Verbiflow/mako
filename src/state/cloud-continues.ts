import { toast } from "sonner"
import { continuedWords, continueTitle } from "@mako/host/contracts/cloud-continues"
import type { ThreadContinueOffer, ThreadContinueOutcome, ThreadContinueStep } from "@mako/host/contracts/cloud-threads"
import { getMako, hasBridge } from "@/lib/bridge"
import { acpStore, updateAcpConversation } from "@/state/acp-state"
import { CLOUD_WHERE } from "@/state/cloud-moves"
import { receiveLive } from "@/state/live-door"
import { hydrateLive } from "@/state/live-recovery"
import { createHook, createStore } from "@/state/store"

/**
 * Continue in the cloud pressed in this window for another device's Thread while that device is off, by the
 * conversation it was pressed from: the step the host is on (`thread-continue-step`). The host carries the press and
 * owns its truth, as a move's; this only mirrors it, so every window agrees.
 */
interface CloudContinuesState {
  continuing: Record<string, { op: string; step: ThreadContinueStep }>
}

export const cloudContinuesStore = createStore<CloudContinuesState>({ continuing: {} })
export const useCloudContinues = createHook(cloudContinuesStore)

/** A step that ends the continue: nothing more comes of its op. */
export function continueEnded(step: ThreadContinueStep): boolean {
  return step.kind === "continued" || step.kind === "failed"
}

/**
 * Presses Continue in the cloud for the Thread of `conversationId`, under a fresh op; its steps arrive as events. A
 * press under way is joined, not pressed again; one that failed is pressed anew, since its op's answer stays failed.
 */
export async function continueInCloud(conversationId: string): Promise<ThreadContinueOutcome | undefined> {
  const held = cloudContinuesStore.get().continuing[conversationId]
  if (!hasBridge() || (held && !continueEnded(held.step))) return undefined
  const op = crypto.randomUUID()
  threadContinueStepped(conversationId, op, { kind: "asking" })
  try {
    return await getMako().threadContinue(conversationId, op)
  } catch (error) {
    // The host said nothing it did: the window says what it heard.
    const reason = error instanceof Error ? error.message : String(error)
    threadContinueStepped(conversationId, op, { kind: "failed", reason })
    return { kind: "failed", reason }
  }
}

/** What the account says a continue would take now, before the press. */
export function askContinueOffer(conversationId: string): Promise<ThreadContinueOffer> {
  return getMako().threadContinueOffer(conversationId)
}

/**
 * A continue's step as the host said it. A step of an op this window no longer shows (a press before a retry) changes
 * nothing. Once continued, the conversation is the cloud's: read again from its machine, where its folder is now.
 */
export function threadContinueStepped(conversationId: string, op: string, step: ThreadContinueStep): void {
  const held = cloudContinuesStore.get().continuing[conversationId]
  if (held && held.op !== op && !continueEnded(held.step) && step.kind !== "asking") return
  if (step.kind !== "continued") {
    cloudContinuesStore.set((state) => ({ continuing: { ...state.continuing, [conversationId]: { op, step } } }))
    return
  }
  // Said once, as a move's landing is: the conversation is the cloud's now, and its window reads it there.
  dismissContinue(conversationId)
  const conversation = acpStore.get().conversations[conversationId]
  const device = (conversation?.kind === "live" && conversation.copy && conversation.elsewhere) || "its computer"
  toast.success(continueTitle("continued"), { id: `continue:${op}`, description: continuedWords(device) })
  // Nothing of it is read from its device's copy now: its window reads it from its machine.
  receiveLive(conversationId, { from: "said" }, () => updateAcpConversation(conversationId, (conversation) => (conversation.kind === "live" ? { ...conversation, elsewhere: CLOUD_WHERE, copy: undefined, quietSince: undefined, cloudContinue: undefined } : conversation)))
  void hydrateLive(conversationId, true)
}

/** The person put away what a continue that ended said. */
export function dismissContinue(conversationId: string): void {
  cloudContinuesStore.set((state) => (state.continuing[conversationId] ? { continuing: Object.fromEntries(Object.entries(state.continuing).filter(([id]) => id !== conversationId)) } : state))
}
