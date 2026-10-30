import type { PromptAttachment } from "@mako/host/contracts/providers-acp"
import { acpStore } from "@/state/acp-state"
import { stagePrompt } from "@/state/acp-pending"
import { replayUnconfirmedPrompts, sendTo, steerTo } from "@/state/acp-queue"
import { commandId, durableAttachments, pendingMessages, settleMessage } from "@/state/message-outbox"
import { createHook, createStore } from "@/state/store"
import { whileBusy } from "./busy"
import { resumeReviewNotes } from "./review-notes"
import type { Sending } from "./delivery"
import { wakeThread, wakingNow } from "./wake"

/**
 * The phone's sends. Each message has one request ID from the moment it leaves the field, the one every try of it
 * carries: the composer mints it and its draft keeps the words under it until they are confirmed (`drafts.ts`), the renderer's outbox
 * (`message-outbox.ts`) keeps the message under it across a reload, and the host settles it by it (`LiveConversations.submit`
 * answers a repeated ID with its first acceptance and refuses one whose words differ). So a message whose answer was
 * lost on the way is never sent twice: asked again, after 1, 2, 4, 8, then every 16 seconds, it is the same request,
 * which the host already holds or takes now, and until it answers the message says "Not confirmed".
 *
 * A message to a cloud Thread whose machine is waking waits for it, drawn at once in the transcript ("Waking…"); a
 * message the host refused before taking it is said under the composer with Retry, unless the field was empty, where
 * its words go back.
 */


/** A message the host refused before taking it, kept with Retry because the field held other words by then. */
export interface UnsentMessage {
  id: string
  conversation: string
  text: string
  attachments: PromptAttachment[]
}

const NOTHING_UNSENT: UnsentMessage[] = []
export const outboxStore = createStore({ sending: new Map<string, Sending>(), unsent: NOTHING_UNSENT })
export const useOutbox = createHook(outboxStore)

function mark(id: string, state: Sending | undefined): void {
  const sending = new Map(outboxStore.get().sending)
  if (state) sending.set(id, state)
  else sending.delete(id)
  outboxStore.set({ sending })
}

/** Where a message goes: its Session's conversation, and the cloud Thread whose machine runs it. */
export interface SendTarget {
  conversation: string
  /** The cloud Thread's ID, when a cloud machine runs it: a send waits for its wake. */
  cloudThread?: string
}

/**
 * Sends one message under `id`, and says whether it went: true once the host took it, or once it may have (its answer
 * lost, the message kept as "Not confirmed" and asked again under the same ID); false when the host refused it.
 */
export function sendMessage(target: SendTarget, id: string, text: string, attachments: PromptAttachment[]): Promise<boolean> {
  // A quiet update's reload waits for it, a machine's wake included (`busy.ts`).
  return whileBusy(deliver(target, id, text, attachments))
}

async function deliver(target: SendTarget, id: string, text: string, attachments: PromptAttachment[]): Promise<boolean> {
  const live = acpStore.get().conversations[target.conversation]
  if (live?.kind !== "live") return false
  const bindingId = live.replyBindingId
  // Drawn in the transcript at once, whatever it waits on: the same request the send stages again below.
  stagePrompt(target.conversation, { id, text, attachments: durableAttachments(attachments), ...(bindingId && { bindingId }) })
  try {
    if (target.cloudThread) {
      if (wakingNow(target.cloudThread)) mark(id, "waking")
      await wakeThread(target.cloudThread, target.conversation)
    }
    mark(id, "sending")
    return await sendTo(target.conversation, text, attachments, id, bindingId)
  } finally {
    mark(id, undefined)
  }
}

/** A refused message kept with Retry: the field held other words when it came back. */
export function keepUnsent(message: UnsentMessage): void {
  outboxStore.set((state) => ({ unsent: [...state.unsent.filter((each) => each.id !== message.id), message] }))
}

/** Sends a refused message again, under the ID it was refused with; refused again, it stays. */
export async function retryUnsent(target: SendTarget, id: string): Promise<void> {
  const message = outboxStore.get().unsent.find((each) => each.id === id)
  if (!message) return
  dropUnsent(id)
  if (!(await sendMessage(target, id, message.text, message.attachments))) keepUnsent(message)
}

export function dropUnsent(id: string): void {
  outboxStore.set((state) => ({ unsent: state.unsent.filter((each) => each.id !== id) }))
}

/** Asks the host again now for a conversation's unconfirmed messages, each under its own ID, instead of at the next backoff. */
export function retryUnconfirmed(conversation: string): Promise<void> {
  return replayUnconfirmedPrompts([conversation])
}

/** Whether the renderer's outbox still holds a message by this ID: it will be asked again under it, not put back. */
export function outboxHolds(id: string): boolean {
  return pendingMessages().some((command) => commandId(command) === id)
}

/**
 * After a conversation opens and its requests are read: the messages this browser left on their way to it (a reload,
 * the page killed mid-send) are drawn again as not confirmed and asked again under their IDs. One the host already
 * holds is only let go.
 */
export function resumeOutbox(conversation: string): void {
  const live = acpStore.get().conversations[conversation]
  if (live?.kind !== "live") return
  // Comments a message carried when the page went: gone with it, still on their way with it, or back in the draft.
  const taken = (request: string) =>
    live.requests?.some((each) => each.id === request) === true || live.control?.actions?.some((each) => each.input.id === request && each.state.kind !== "not-accepted") === true
  resumeReviewNotes(conversation, taken, outboxHolds)
  for (const command of pendingMessages()) {
    if ((command.kind !== "prompt" && command.kind !== "steer") || command.conversationId !== conversation) continue
    if (live.requests?.some((request) => request.id === command.requestId)) {
      settleMessage(command.requestId)
      continue
    }
    if (command.kind === "steer") {
      // A steer the host has is settled by its answer; one it refused, or never heard, goes again (`steerTo`).
      const action = live.control?.actions?.find((each) => each.input.id === command.requestId)
      if (!action || action.state.kind === "not-accepted") void steerTo(conversation, command.text, command.attachments, command.requestId)
      continue
    }
    stagePrompt(conversation, { id: command.requestId, text: command.text, attachments: command.attachments, ...(command.bindingId && { bindingId: command.bindingId }), delivery: { tuning: command.tuning }, unconfirmed: true })
    void sendTo(conversation, command.text, command.attachments, command.requestId, command.bindingId)
  }
}
