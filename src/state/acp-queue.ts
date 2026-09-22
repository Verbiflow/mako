import { continueTurnPrompt, type PendingPrompt } from "@/state/prompt-delivery"
import type { InterruptionReason } from "@/lib/types"
import type { QueuedPromptEdit } from "../../electron/contracts/live-queue"
import { threadsStore } from "@/state/thread-store"
import { applyLiveSnapshot, hydrateLive } from "@/state/live-recovery"
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
import { commandId, durableAttachments, pendingMessages, saveMessage, settleMessage } from "@/state/message-outbox"

function updateLive(
  id: string,
  update: (conversation: LiveAcpConversation) => LiveAcpConversation
): LiveAcpConversation | null {
  const next = updateAcpConversation(id, (conversation) =>
    conversation.kind === "live" ? update(conversation) : conversation
  )
  return next?.kind === "live" ? next : null
}

const deliveries = new Map<string, Promise<boolean>>()
const retries = new Map<string, ReturnType<typeof setTimeout>>()
const retryDelays = new Map<string, number>()

function scheduleRecovery(id: string): void {
  if (retries.has(id)) return
  const delay = retryDelays.get(id) ?? 1_000
  retries.set(id, setTimeout(() => {
    retries.delete(id)
    void replayUnconfirmedPrompts([id])
  }, delay))
  retryDelays.set(id, Math.min(delay * 2, 30_000))
}

export function sendTo(
  id: string, text: string, attachments: PromptAttachment[] = [],
  requestId: string = crypto.randomUUID(), bindingId?: string
): Promise<boolean> {
  const existing = deliveries.get(requestId)
  if (existing) return existing
  const delivery = attemptSend(id, text, attachments, requestId, bindingId)
    .finally(() => deliveries.delete(requestId))
  deliveries.set(requestId, delivery)
  return delivery
}

async function attemptSend(
  id: string,
  text: string,
  attachments: PromptAttachment[] = [],
  requestId: string = crypto.randomUUID(),
  bindingId?: string
): Promise<boolean> {
  const current = acpStore.get().conversations[id]
  if (!current || current.kind !== "live" || !hasBridge()) return false
  attachments = durableAttachments(attachments)
  noteFolderUse(current.session.cwd)
  stagePrompt(id, { id: requestId, text, attachments, bindingId })
  updateLive(id, (conversation) => ({
    ...conversation,
    sending: true,
    updatedAt: Date.now(),
  }))
  const alreadyUnconfirmed = current.pendingPrompts?.some((prompt) => prompt.id === requestId && prompt.unconfirmed) ?? false
  try {
    const staged = acpStore.get().conversations[id]?.pendingPrompts?.find((prompt) => prompt.id === requestId)
    const tuning = staged?.delivery ? staged.delivery.tuning
      : await settingsForSend(liveSettingsTarget({ ...current, replyBindingId: bindingId ?? current.replyBindingId }))
    updateAcpConversation(id, (conversation) => ({ ...conversation,
      pendingPrompts: conversation.pendingPrompts?.map((prompt) => prompt.id === requestId ? { ...prompt, delivery: { tuning } } : prompt),
    }))
    saveMessage({ kind: "prompt", conversationId: id, requestId, text, attachments, bindingId, tuning })
    if (bindingId) await getMako().liveContinue(id, bindingId, requestId, text, attachments, tuning)
    else await getMako().livePrompt(id, requestId, text, attachments, tuning)
    settleMessage(requestId)
    updateAcpConversation(id, (conversation) => ({ ...conversation, pendingPrompts: conversation.pendingPrompts?.map((prompt) => prompt.id === requestId ? { ...prompt, unconfirmed: false } : prompt) }))
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
      settleMessage(requestId)
      return true
    }
    if (alreadyUnconfirmed || (error instanceof Error && isHostReconnectingError(error))) {
      // RPC and event connections fail independently. Recover this command
      // even if no stream disconnect/reconnect event ever arrives.
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
      scheduleRecovery(id)
      return true
    }
    settleMessage(requestId)
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
export async function replayUnconfirmedPrompts(ids?: string[], hydrated: ReadonlySet<string> = new Set()): Promise<void> {
  const conversations = Object.values(acpStore.get().conversations)
  for (const conversation of conversations) {
    if (conversation.kind !== "live" || (ids && !ids.includes(conversation.key))) continue
    if (!conversation.pendingPrompts?.some((prompt) => prompt.unconfirmed)) continue
    if (!hydrated.has(conversation.key) && !await hydrateLive(conversation.key, true)) {
      scheduleRecovery(conversation.key)
      continue
    }
    const unconfirmed = acpStore.get().conversations[conversation.key]?.pendingPrompts?.filter((prompt) => prompt.unconfirmed) ?? []
    for (const prompt of unconfirmed)
      await sendTo(conversation.key, prompt.text, prompt.attachments, prompt.id, prompt.bindingId)
    if (acpStore.get().conversations[conversation.key]?.pendingPrompts?.some((prompt) => prompt.unconfirmed)) scheduleRecovery(conversation.key)
    else {
      clearTimeout(retries.get(conversation.key))
      retries.delete(conversation.key)
      retryDelays.delete(conversation.key)
    }
  }
}

/** Recover commands before their host receipt was acknowledged, including after reload. */
let restoring: Promise<void> | undefined
let restoreAgain = false
export function restorePendingMessages(): Promise<void> {
  restoreAgain = true
  if (!restoring) restoring = (async () => {
    do {
      restoreAgain = false
      await restoreMessages()
    } while (restoreAgain)
  })().finally(() => { restoring = undefined })
  return restoring
}
async function restoreMessages(): Promise<void> {
  for (let command of pendingMessages()) {
    if (command.kind === "start") {
      const { restorePendingStart } = await import("@/state/acp-start")
      await restorePendingStart(command)
      continue
    }
    if (command.kind === "queued") {
      const resolved = pendingMessages().find((entry) => entry.kind === "prompt" && entry.requestId === commandId(command))
      if (!resolved || resolved.kind !== "prompt") { scheduleOutboxRecovery(); continue }
      command = resolved
    }
    const { conversationId: id, requestId, text, attachments, bindingId, tuning } = command
    if (!await hydrateLive(id, true)) {
      // Keep the durable command even while no live summary is available.
      scheduleOutboxRecovery()
      continue
    }
    const current = acpStore.get().conversations[id]
    if (current?.requests?.some((request) => request.id === requestId) ||
        current?.control?.transfers.some((transfer) => transfer.input.id === requestId)) {
      settleMessage(requestId)
      continue
    }
    stagePrompt(id, { id: requestId, text, attachments, bindingId, delivery: { tuning }, unconfirmed: true })
    await sendTo(id, text, attachments, requestId, bindingId)
  }
}
let outboxRetry: ReturnType<typeof setTimeout> | undefined
function scheduleOutboxRecovery(): void {
  if (outboxRetry) return
  outboxRetry = setTimeout(() => { outboxRetry = undefined; void restorePendingMessages() }, 10_000)
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
