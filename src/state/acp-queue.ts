import { continueTurnPrompt, type PendingPrompt } from "@/state/prompt-delivery"
import type { InterruptionReason } from "@/lib/types"
import type { QueuedPromptEdit } from "@mako/host/contracts/live-queue"
import { threadsStore } from "@/state/thread-store"
import { applyLiveSnapshot, hydrateLive, readLive } from "@/state/live-recovery"
import { stagePrompt, removePendingPrompt } from "@/state/acp-pending"
import { liveSettingsTarget, settingsForSend } from "@/state/composer-settings"
import { revealWorkedProject } from "@/state/prefs"
import { getMako, hasBridge } from "@/lib/bridge"
import type { LiveActionInput, LiveSnapshot, PromptAttachment } from "@/lib/types"
import { readLiveSnapshot } from "@/state/live-history"
import {
  acpStore,
  updateAcpConversation,
  type LiveAcpConversation,
} from "@/state/acp-state"
import { projectAcp } from "@/state/live-projection"
import { toast } from "sonner"
import { hostConnectionStore } from "@/state/host-connection"
import { quietTimer, waitsFor, withinPatience } from "@/state/delivery-policy"
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
/** A waiting message is asked again after 1 s, then 2, 4, 8 and every 16 s: under its one id, so never twice. */
const FIRST_RETRY_MS = 1_000
const LAST_RETRY_MS = 16_000
/** How long a steer the host is busy with another (a steer on its way, a turn ending) is tried again before it queues. */
const STEER_BUSY_MS = 2_000
const STEER_BUSY_STEP_MS = 250

function scheduleRecovery(id: string): void {
  if (retries.has(id)) return
  const delay = retryDelays.get(id) ?? FIRST_RETRY_MS
  retries.set(id, quietTimer(() => {
    retries.delete(id)
    void replayUnconfirmedPrompts([id])
  }, delay))
  retryDelays.set(id, Math.min(delay * 2, LAST_RETRY_MS))
}

/** One conversation's messages reach the host one at a time, in the order the person sent them. */
const lanes = new Map<string, Promise<void>>()
function inLane<T>(conversation: string, run: () => Promise<T>): Promise<T> {
  const next = (lanes.get(conversation) ?? Promise.resolve()).then(run)
  const tail = next.then(() => undefined, () => undefined)
  lanes.set(conversation, tail)
  void tail.then(() => { if (lanes.get(conversation) === tail) lanes.delete(conversation) })
  return next
}

/** Marks a staged message as waiting in this device's outbox, `why`, for the next try (`scheduleRecovery`). */
function markWaiting(id: string, requestId: string, why: string): void {
  updateAcpConversation(id, (current) => {
    const next = {
      ...current,
      pendingPrompts: current.pendingPrompts?.map((prompt) =>
        prompt.id === requestId ? { ...prompt, unconfirmed: true, waiting: why } : prompt
      ),
    }
    return { ...next, projection: projectAcp(next) }
  })
  updateLive(id, (conversation) => ({ ...conversation, sending: false, updatedAt: Date.now() }))
  scheduleRecovery(id)
}

/** Why a message can't go to the host yet before any try: Mako is away, or an earlier message of the conversation still waits. */
function holdsBack(id: string, requestId: string): string | undefined {
  if (hostConnectionStore.get().kind === "disconnected") return "Waiting for Mako to reconnect"
  const pending = acpStore.get().conversations[id]?.pendingPrompts ?? []
  const at = pending.findIndex((prompt) => prompt.id === requestId)
  return pending.slice(0, at < 0 ? pending.length : at).some((prompt) => prompt.unconfirmed) ? "Waiting behind an earlier message" : undefined
}

/**
 * A message to the conversation, after what it holds: drawn and kept in this device's outbox at once, then sent to the
 * host in order. Answers false only when the host refused it for good; a host that's away, slow or busy keeps it waiting
 * (`waitsFor`), and it goes by itself, under its one ID, once the host can take it.
 */
export function sendTo(
  id: string, text: string, attachments: PromptAttachment[] = [],
  requestId: string = crypto.randomUUID(), bindingId?: string
): Promise<boolean> {
  const existing = deliveries.get(requestId)
  if (existing) return existing
  const current = acpStore.get().conversations[id]
  if (current?.kind === "live") stagePrompt(id, { id: requestId, text, attachments: durableAttachments(attachments), bindingId })
  const delivery = inLane(id, () => attemptSend(id, text, attachments, requestId, bindingId))
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
  updateAcpConversation(id, (conversation) => ({ ...conversation,
    pendingPrompts: conversation.pendingPrompts?.map((prompt) => prompt.id === requestId ? { ...prompt, steering: undefined } : prompt),
  }))
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
    const held = holdsBack(id, requestId)
    if (held) {
      markWaiting(id, requestId, held)
      return true
    }
    if (bindingId) await withinPatience(getMako().liveContinue(id, bindingId, requestId, text, attachments, tuning))
    else await withinPatience(getMako().livePrompt(id, requestId, text, attachments, tuning))
    settleMessage(requestId)
    updateAcpConversation(id, (conversation) => ({ ...conversation, pendingPrompts: conversation.pendingPrompts?.map((prompt) => prompt.id === requestId ? { ...prompt, unconfirmed: false, waiting: undefined } : prompt) }))
    return true
  } catch (error) {
    const tookIt = (snapshot: LiveSnapshot | null) =>
      snapshot?.requests.some((request) => request.id === requestId) ||
      snapshot?.control?.transfers.some(
        (transfer) => transfer.input.id === requestId
      ) ||
      // Steered into the turn under this ID before it came here as a message (`steerTo`).
      snapshot?.control?.actions?.some((action) => action.input.id === requestId && action.state.kind !== "not-accepted")
    const snapshot = await readLive(id, () => withinPatience(getMako().liveSnapshot(id)).catch(() => null), (read) => {
      if (tookIt(read)) applyLiveSnapshot(read)
    })
    if (tookIt(snapshot)) {
      settleMessage(requestId)
      return true
    }
    const waiting = error instanceof Error ? waitsFor(error) : undefined
    if (alreadyUnconfirmed || waiting) {
      // RPC and event connections fail independently. Recover this command
      // even if no stream disconnect/reconnect event ever arrives.
      markWaiting(id, requestId, waiting ?? (error instanceof Error ? error.message : String(error)))
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

/** How a steer went: into the turn, refused (with why, when the person should hear it), or not known yet (with why). */
type Steered = "steered" | { refused: string | undefined } | { unknown: string }

/**
 * A message into the running turn, kept in the outbox under the composer's request ID like any send, which its action
 * takes, and drawn at once as steering: a page that dies mid-steer finds it there again, and never puts its words back
 * once the steer landed. With no turn to steer (it ended between the tap and now) or a steer the host refused before
 * the harness heard it, the words go as the next message under the same ID. The host takes one ID once, as a steer or
 * as a message, never both (`LiveConversations.submit`, `LiveActions.submit`).
 */
export function steerTo(id: string, text: string, attachments: PromptAttachment[] = [], requestId: string = crypto.randomUUID()): Promise<boolean> {
  const existing = deliveries.get(requestId)
  if (existing) return existing
  const current = acpStore.get().conversations[id]
  if (current?.kind === "live") stagePrompt(id, { id: requestId, text, attachments: durableAttachments(attachments), steering: true })
  const delivery = inLane(id, () => attemptSteer(id, text, attachments, requestId)).finally(() => deliveries.delete(requestId))
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
  stagePrompt(id, { id: requestId, text, attachments, steering: true })
  const held = holdsBack(id, requestId)
  if (held) {
    markWaiting(id, requestId, held)
    return true
  }
  const input: Extract<LiveActionInput, { kind: "steer" }> = { kind: "steer", id: requestId, requestId: turn.id, text, attachments }
  let steered = await steerOnce(id, input)
  for (const by = Date.now() + STEER_BUSY_MS; steered !== "steered" && "busy" in steered && Date.now() < by;) {
    await new Promise((resolve) => setTimeout(resolve, STEER_BUSY_STEP_MS))
    steered = await steerOnce(id, input)
  }
  if (steered === "steered") {
    settleMessage(requestId)
    // The turn shows its words now, as the host wrote them into it.
    removePendingPrompt(id, requestId)
    return true
  }
  // Kept in the outbox: the host is asked again once it's back, which never sends it twice.
  if ("unknown" in steered) {
    markWaiting(id, requestId, steered.unknown)
    return true
  }
  if (steered.refused) toast(steered.refused)
  return attemptSend(id, text, attachments, requestId, current.replyBindingId)
}

async function steerOnce(id: string, input: Extract<LiveActionInput, { kind: "steer" }>): Promise<Steered | { busy: string; refused: string | undefined }> {
  try {
    const action = await withinPatience(getMako().liveAction(id, input))
    if (action.state.kind === "not-accepted") return { refused: action.state.reason }
    if (action.state.kind === "uncertain" || action.state.kind === "failed") toast.error(action.state.reason)
    return "steered"
  } catch (error) {
    const snapshot = await readLive(id, () => withinPatience(readLiveSnapshot(id)).catch(() => null))
    const receipt = snapshot?.control?.actions?.find((action) => action.input.id === input.id)
    if (receipt) return receipt.state.kind === "not-accepted" ? { refused: receipt.state.reason } : "steered"
    // It came first as a message of its own: that is where its words went.
    if (snapshot?.requests.some((request) => request.id === input.id)) return "steered"
    const reason = error instanceof Error ? error.message : String(error)
    const waiting = error instanceof Error ? waitsFor(error) : undefined
    // The host is away or slow: its answer, or the next try under this ID, says where the words went.
    if (waiting && !BUSY_STEER.test(reason)) return { unknown: waiting }
    if (waiting) return { busy: waiting, refused: undefined }
    return { refused: steerRefusal(reason) }
  }
}

/** A refusal that means the host is busy with another steer or a turn ending: tried again for a moment, then queued. */
const BUSY_STEER = /Resolve the previous provider action|Wait for this conversation to connect|is still ending the previous turn/i

/**
 * What the person hears of a steer the host refused before taking it, which then goes as the next message: nothing
 * when the turn it was for had just ended, as a message sent then would have gone the same way.
 */
function steerRefusal(reason: string): string | undefined {
  if (/no longer running|has not started yet/i.test(reason)) return undefined
  return `Mako couldn't steer your message into the running turn (${reason.replace(/[.\s]+$/, "")}), so it goes as the next message.`
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
      await (prompt.steering ? steerTo(conversation.key, prompt.text, prompt.attachments, prompt.id) : sendTo(conversation.key, prompt.text, prompt.attachments, prompt.id, prompt.bindingId))
    if (acpStore.get().conversations[conversation.key]?.pendingPrompts?.some((prompt) => prompt.unconfirmed)) scheduleRecovery(conversation.key)
    else {
      clearTimeout(retries.get(conversation.key))
      retries.delete(conversation.key)
      retryDelays.delete(conversation.key)
    }
  }
}

/** Asks the host now for a conversation's waiting messages, in order, instead of at the next backoff. */
export function sendWaitingNow(conversation: string): Promise<void> {
  clearTimeout(retries.get(conversation))
  retries.delete(conversation)
  retryDelays.delete(conversation)
  return replayUnconfirmedPrompts([conversation])
}

/**
 * Takes a waiting message out of this device's outbox, between tries. A try the host never answered may still have
 * reached it: then the host's queue shows it, where it can be removed too.
 */
export function discardWaiting(conversation: string, requestId: string): boolean {
  if (deliveries.has(requestId)) return false
  settleMessage(requestId)
  removePendingPrompt(conversation, requestId)
  return true
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
    await readLive(target.id, () => getMako().liveEditQueued(target.id, input))
  }
}
