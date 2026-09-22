import { continueTurnPrompt, type PendingPrompt } from "@/state/prompt-delivery"
import type { InterruptionReason } from "@/lib/types"
import type { QueuedPromptEdit } from "../../electron/contracts/live-queue"
import { threadsStore } from "@/state/thread-store"
import { applyLiveSnapshot } from "@/state/live-recovery"
import { stagePrompt, removePendingPrompt } from "@/state/acp-pending"
import { liveSettingsTarget, settingsForSend } from "@/state/composer-settings"
import { noteFolderUse } from "@/state/prefs"
import { getMako, hasBridge } from "@/lib/bridge"
import type { PromptAttachment } from "@/lib/types"
import {
  acpStore,
  updateAcpConversation,
  type LiveAcpConversation,
} from "@/state/acp-state"
import { projectAcp } from "@/state/live-projection"
import { isHostReconnectingError } from "../../electron/contracts/host-connection"
import { toast } from "sonner"

function updateLive(
  id: string,
  update: (conversation: LiveAcpConversation) => LiveAcpConversation
): LiveAcpConversation | null {
  const next = updateAcpConversation(id, (conversation) =>
    conversation.kind === "live" ? update(conversation) : conversation
  )
  return next?.kind === "live" ? next : null
}

export async function sendTo(
  id: string,
  text: string,
  attachments: PromptAttachment[] = [],
  requestId: string = crypto.randomUUID()
): Promise<boolean> {
  const current = acpStore.get().conversations[id]
  if (!current || current.kind !== "live" || !hasBridge()) return false
  noteFolderUse(current.session.cwd)
  stagePrompt(id, { id: requestId, text, attachments })
  updateLive(id, (conversation) => ({
    ...conversation,
    sending: true,
    updatedAt: Date.now(),
  }))
  try {
    await getMako().livePrompt(
      id,
      requestId,
      text,
      attachments,
      await settingsForSend(liveSettingsTarget(current))
    )
    return true
  } catch (error) {
    const snapshot = await getMako()
      .liveSnapshot(id)
      .catch(() => null)
    if (
      snapshot?.requests.some((request) => request.id === requestId) ||
      snapshot?.control?.transfers.some(
        (transfer) => transfer.input.id === requestId
      )
    ) {
      if (snapshot) applyLiveSnapshot(snapshot)
      return true
    }
    if (error instanceof Error && isHostReconnectingError(error)) {
      // The transport already waited for the host once. The paragraph stays
      // staged under its id; `replayUnconfirmedPrompts` re-issues it when the
      // host is back and the reconnect banner says so meanwhile.
      updateAcpConversation(id, (current) => {
        const next = {
          ...current,
          pendingPrompts: current.pendingPrompts?.map((prompt) =>
            prompt.id === requestId ? { ...prompt, unconfirmed: true } : prompt
          ),
        }
        return { ...next, projection: projectAcp(next) }
      })
      updateLive(id, (conversation) => ({
        ...conversation,
        sending: false,
        updatedAt: Date.now(),
      }))
      return true
    }
    removePendingPrompt(id, requestId)
    updateLive(id, (conversation) => ({
      ...conversation,
      sending: false,
      updatedAt: Date.now(),
    }))
    toast.error(error instanceof Error ? error.message : String(error))
    return false
  }
}

/**
 * Pick up a turn that was cut short — by Mako's exit or by the provider's
 * own dropped connection. The provider kept the session; a short prompt asks
 * it to go on, through the same send as any other message, so the request
 * queues, steers or resumes exactly as one typed would.
 */
export function continueTurn(id: string, reason: InterruptionReason = "host-quit"): Promise<boolean> {
  return sendTo(id, continueTurnPrompt(reason))
}

/**
 * Re-issue every prompt a send left unconfirmed, once the host is back. The
 * host settles a request by its id, so a prompt it already accepted comes
 * back as that acceptance and one it never saw is accepted now; nothing is
 * delivered twice. Called from the reconnect, after the summaries are known.
 */
export async function replayUnconfirmedPrompts(ids?: string[]): Promise<void> {
  const conversations = Object.values(acpStore.get().conversations)
  for (const conversation of conversations) {
    if (conversation.kind !== "live" || (ids && !ids.includes(conversation.key))) continue
    const unconfirmed = conversation.pendingPrompts?.filter((prompt) => prompt.unconfirmed) ?? []
    for (const prompt of unconfirmed) {
      updateAcpConversation(conversation.key, (current) => ({
        ...current,
        pendingPrompts: current.pendingPrompts?.map((item) =>
          item.id === prompt.id ? { ...item, unconfirmed: false } : item
        ),
      }))
      await sendTo(conversation.key, prompt.text, prompt.attachments, prompt.id)
    }
  }
}

export type QueueTarget =
  { kind: "live"; id: string } | { kind: "native"; path: string }

export async function editQueuedPrompt(
  target: QueueTarget,
  request: PendingPrompt,
  change: QueuedPromptEdit["change"]
): Promise<void> {
  const input = { requestId: request.id, expectedText: request.text, change }
  if (target.kind === "native") {
    const previous = threadsStore.get().nativeRequests
    const updated = await getMako().nativeEditQueued(input)
    if (threadsStore.get().nativeRequests === previous)
      threadsStore.set({ nativeRequests: updated })
  } else {
    applyLiveSnapshot(await getMako().liveEditQueued(target.id, input))
  }
}
