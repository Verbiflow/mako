import { continueTurnPrompt, type PendingPrompt } from "@/state/prompt-delivery"
import type { InterruptionReason } from "@/lib/types"
import type { QueuedPromptEdit } from "@mako/host/contracts/live-queue"
import { threadsStore } from "@/state/thread-store"
import { applyLiveSnapshot, hydrateLive } from "@/state/live-recovery"
import { stagePrompt, removePendingPrompt } from "@/state/acp-pending"
import { liveSettingsTarget, settingsForSend } from "@/state/composer-settings"
import { revealWorkedProject } from "@/state/prefs"
import { getMako, hasBridge } from "@/lib/bridge"
import type { LiveActionInput, PromptAttachment } from "@/lib/types"
import { readLiveSnapshot } from "@/state/live-history"
import {
  acpStore,
  updateAcpConversation,
  type LiveAcpConversation,
} from "@/state/acp-state"
import { projectAcp } from "@/state/live-projection"
import { isHostReconnectingError } from "@mako/host/contracts/host-connection"
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
/** An unconfirmed message is asked again after 1 s, then 2, 4, 8 and every 16 s: under its one id, so never twice. */
const FIRST_RETRY_MS = 1_000
const LAST_RETRY_MS = 16_000

function scheduleRecovery(id: string): void {
  if (retries.has(id)) return
  const delay = retryDelays.get(id) ?? FIRST_RETRY_MS
  retries.set(id, setTimeout(() => {
    retries.delete(id)
    void replayUnconfirmedPrompts([id])
  }, delay))
  retryDelays.set(id, Math.min(delay * 2, LAST_RETRY_MS))
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
  revealWorkedProject(current.session.cwd)
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
      ) ||
      // Steered into the turn under this ID before it came here as a message (`steerTo`).
      snapshot?.control?.actions?.some((action) => action.input.id === requestId && action.state.kind !== "not-accepted")
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

/** What became of a steer: the turn took it (or may have), the host refused it before the harness heard it, or its answer was lost. */
type Steered = "steered" | "refused" | "unknown"

/**
 * A message into the running turn, kept in the outbox under the composer's request ID like any send, which its action
 * takes: a page that dies mid-steer finds it there again, and never puts its words back once the steer landed. With no
 * turn to steer (it ended between the tap and now) or a steer the host refused before the harness heard it (another
 * steer on its way, the turn just ending), the words go as the next message under the same ID. The host takes one ID
 * once, as a steer or as a message, never both (`LiveConversations.submit`, `LiveActions.submit`).
 */
export function steerTo(id: string, text: string, attachments: PromptAttachment[] = [], requestId: string = crypto.randomUUID()): Promise<boolean> {
  const existing = deliveries.get(requestId)
  if (existing) return existing
  const delivery = attemptSteer(id, text, attachments, requestId).finally(() => deliveries.delete(requestId))
  deliveries.set(requestId, delivery)
  return delivery
}

async function attemptSteer(id: string, text: string, attachments: PromptAttachment[], requestId: string): Promise<boolean> {
  const current = acpStore.get().conversations[id]
  if (current?.kind !== "live" || !hasBridge()) return false
  attachments = durableAttachments(attachments)
  const turn = current.session.status === "running" ? current.requests?.find((request) => request.status === "dispatching") : undefined
  if (!turn) return attemptSend(id, text, attachments, requestId, current.replyBindingId)
  saveMessage({ kind: "steer", conversationId: id, requestId, text, attachments })
  const steered = await steerOnce(id, { kind: "steer", id: requestId, requestId: turn.id, text, attachments })
  if (steered === "steered") {
    settleMessage(requestId)
    return true
  }
  // Kept in the outbox: the host is asked again once it's back (`restorePendingMessages`).
  if (steered === "unknown") return true
  return attemptSend(id, text, attachments, requestId, current.replyBindingId)
}

async function steerOnce(id: string, input: Extract<LiveActionInput, { kind: "steer" }>): Promise<Steered> {
  try {
    const action = await getMako().liveAction(id, input)
    if (action.state.kind === "not-accepted") return "refused"
    if (action.state.kind === "uncertain" || action.state.kind === "failed") toast.error(action.state.reason)
    return "steered"
  } catch (error) {
    const snapshot = await readLiveSnapshot(id).catch(() => null)
    if (snapshot) applyLiveSnapshot(snapshot)
    const receipt = snapshot?.control?.actions?.find((action) => action.input.id === input.id)
    if (receipt) return receipt.state.kind === "not-accepted" ? "refused" : "steered"
    // It came first as a message of its own: that is where its words went.
    if (snapshot?.requests.some((request) => request.id === input.id)) return "steered"
    return error instanceof Error && isHostReconnectingError(error) ? "unknown" : "refused"
  }
}

/**
 * Pick up a turn that was cut short — by Mako's exit or by the provider's
 * own dropped connection. The provider kept the session; a short prompt asks
 * it to go on, through the same send as any other message, so it resumes
 * the session exactly as one typed would. It names the background work the
 * cut stopped, as the host recorded it on the turn (`Interruption.stopped`),
 * the same words Mako's own continuation uses. Only a turn that has stopped
 * is picked up: while one runs or a message waits to go, there is nothing to
 * continue, and the words would only queue behind it as if the person had
 * typed them, so nothing is sent.
 */
export function continueTurn(id: string, reason: InterruptionReason = "host-quit"): Promise<boolean> {
  const conversation = acpStore.get().conversations[id]
  if (conversation?.kind === "live" && turnUnderWay(conversation)) return Promise.resolve(false)
  const cut = conversation?.requests?.findLast((request) => request.interruption?.reason === reason)
  return sendTo(id, continueTurnPrompt(reason, "person", cut?.interruption?.stopped))
}

/** A turn runs, or a message waits to go: a continuation would queue behind it rather than pick anything up. */
export function turnUnderWay(conversation: Pick<LiveAcpConversation, "session" | "requests" | "pendingPrompts">): boolean {
  return conversation.session.status === "running" || conversation.session.status === "starting" ||
    Boolean(conversation.requests?.some((request) => request.status === "dispatching" || request.status === "queued")) ||
    Boolean(conversation.pendingPrompts?.length)
}

/**
 * Send a failed message again at `at`: the host admits a new request with its
 * words and attachments, held until then (`LiveRequest.wake`), and the queue
 * shows it with its time. The failed record stays.
 */
export async function holdUntil(id: string, after: string, at: number): Promise<boolean> {
  if (!hasBridge()) return false
  try {
    await getMako().liveHoldUntil(id, crypto.randomUUID(), { after, at })
    return true
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
    return false
  }
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
    if (command.kind === "steer") {
      const { conversationId, requestId, text, attachments } = command
      if (!await hydrateLive(conversationId, true)) {
        scheduleOutboxRecovery()
        continue
      }
      const current = acpStore.get().conversations[conversationId]
      const action = current?.control?.actions?.find((each) => each.input.id === requestId)
      // Taken, it was settled with the snapshot; still on its way, the host's answer settles it. Refused, it goes as a message.
      if (action && action.state.kind !== "not-accepted") continue
      if (current?.requests?.some((request) => request.id === requestId)) {
        settleMessage(requestId)
        continue
      }
      await steerTo(conversationId, text, attachments, requestId)
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
