import { z } from "zod"

/**
 * Messages for a Session whose owner is off: sent from another device, kept by the account (not by the device that
 * sent them, which may sleep too) until the Session's owner takes them. Each is the request it becomes, under its own
 * ID: the owner admits it under that ID, which a host settles once, so a message taken twice runs once, and it says
 * it took it, which ends its wait. A message waits for the Session, not a device: if the Session moves meanwhile, its
 * new owner takes it. Every device hears a Session's waiting messages whole (`messages-waiting`), so each shows the
 * same, and any of the account's devices may take one back before it's taken.
 */

/** The most messages one Session holds waiting, and the most a message says. */
export const WAITING_PER_SESSION = 20
export const WAITING_TEXT_CHARS = 100_000

/** What a device sends to wait: the conversation the list named, and the message. Text only: a file attached stays where it was sent from. */
export const WaitingInputSchema = z
  .object({
    conversation: z.string().min(1).max(128),
    text: z.string().min(1).max(WAITING_TEXT_CHARS),
    /** What the sender's window showed as the message, when it isn't `text` (its context written out). */
    displayText: z.string().max(WAITING_TEXT_CHARS).optional(),
  })
  .strict()
export type WaitingInput = z.infer<typeof WaitingInputSchema>

/** A message waiting, as the account keeps it: its ID, its Session, and who sent it when, which the cloud says. */
export const WaitingMessageSchema = WaitingInputSchema.extend({
  id: z.uuid(),
  session: z.uuid(),
  from: z.uuid(),
  at: z.iso.datetime(),
}).strip()
export type WaitingMessage = z.infer<typeof WaitingMessageSchema>

/** `GET /v1/waiting`: the messages waiting for the Sessions the asking device owns, oldest first. */
export const WaitingListSchema = z.object({ messages: z.array(WaitingMessageSchema) })
export type WaitingList = z.infer<typeof WaitingListSchema>

/** Whether two messages say the same: a message sent again under its ID is the same message, or refused. */
export function sameWaiting(left: WaitingInput, right: WaitingInput): boolean {
  return left.conversation === right.conversation && left.text === right.text && left.displayText === right.displayText
}
