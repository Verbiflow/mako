import type { Block, ChatMessage } from "@/lib/types"
import { textOf } from "@/lib/format"

/**
 * An exchange is one question and everything the agent did to answer it.
 *
 * The transcript is grouped this way because that is the unit people actually
 * think in. It also settles two things that were wrong when every message was
 * its own row: "copy" belongs to the whole answer rather than appearing on
 * each fragment of it, and the turn navigator has something meaningful to jump
 * between.
 */
/**
 * The one exchange without a prompt: what the agent said before the first
 * question on screen. It is the first exchange whenever it exists, and it
 * absorbs whatever earlier history is loaded above it, so its id must not
 * depend on which message currently opens it — a changing id remounted the
 * exchange and dropped the reading position every time history arrived.
 */
export const LEAD_EXCHANGE_ID = "lead"

export interface Exchange {
  /** Stable across re-renders: the id of the message that opened the exchange. */
  id: string
  /** The user's message, absent for anything the agent said unprompted. */
  prompt?: ChatMessage
  /**
   * Everything after the prompt, in order: assistant and tool messages, and
   * any message the user steered in while the agent was still working. A
   * steer stays where it landed — after the work it interrupted, before the
   * work it redirected — never hoisted next to the prompt.
   */
  response: ChatMessage[]
  /** Notes and separators that landed inside this exchange, in order. */
  system: ExchangeNote[]
  timestamp?: number
}

/**
 * A note keeps its place in the answer: `after` counts the response messages
 * before it. Zero sits under the prompt; anything later splits the answer
 * where it happened, so a summary halfway through a long turn reads there.
 */
export interface ExchangeNote {
  message: ChatMessage
  after: number
}

export type ResponseSection =
  | { kind: "prose"; id: string; message: ChatMessage }
  | { kind: "work"; id: string; messages: ChatMessage[] }
  | { kind: "steer"; id: string; message: ChatMessage }
  | { kind: "note"; id: string; message: ChatMessage }

/** The provider's own marker for a turn that was stopped. */
export function isInterruptedNote(message: ChatMessage): boolean {
  return message.blocks.some((block) =>
    block.type === "text" ? /^Interrupted(?:\s|$)/i.test(block.text.trim()) : false
  )
}

/**
 * The notes a turn shows once its footer says it stopped. The provider's own
 * marker at either edge of the answer repeats the footer; one between parts
 * of the answer marks where it was cut (a steer) and stays.
 */
export function notesBesideStop(notes: readonly ExchangeNote[], responses: number): ExchangeNote[] {
  return notes.filter(
    (note) => !isInterruptedNote(note.message) || (note.after > 0 && note.after < responses)
  )
}

/** `notes` must be ordered by `after`; notes at zero belong above the answer and are skipped. */
export function responseSections(
  messages: ChatMessage[],
  notes: readonly ExchangeNote[] = []
): ResponseSection[] {
  const sections: ResponseSection[] = []
  let work: ChatMessage[] = []
  let part = 0

  const flushWork = () => {
    const first = work[0]
    if (!first) return
    sections.push({ kind: "work", id: `work-${first.id}`, messages: work })
    work = []
  }
  const splitMessage = (message: ChatMessage, blocks: Block[]) => ({
    ...message,
    id: `${message.id}-part-${part++}`,
    blocks,
    error: undefined,
  })
  let note = 0
  while (notes[note]?.after === 0) note++
  const placeNotes = (upTo: number) => {
    while (note < notes.length && notes[note]!.after <= upTo) {
      flushWork()
      const { message } = notes[note++]!
      sections.push({ kind: "note", id: message.id, message })
    }
  }

  for (const [index, message] of messages.entries()) {
    placeNotes(index)
    if (message.role === "user") {
      flushWork()
      sections.push({ kind: "steer", id: message.id, message })
      continue
    }
    const generated: ChatMessage[] = []
    let workBlocks: Block[] = []
    const flushMessageWork = () => {
      if (workBlocks.length === 0) return
      const split = splitMessage(message, workBlocks)
      work.push(split)
      generated.push(split)
      workBlocks = []
    }

    for (const block of message.blocks) {
      if (
        message.role === "assistant" &&
        ((block.type === "text" && block.text) ||
          block.type === "attachment" ||
          block.type === "proposed-plan")
      ) {
        flushMessageWork()
        flushWork()
        const prose = splitMessage(message, [block])
        generated.push(prose)
        sections.push({ kind: "prose", id: prose.id, message: prose })
      } else {
        workBlocks.push(block)
      }
    }
    flushMessageWork()
    if (generated.length === 0 && message.error) {
      flushWork()
      const prose = splitMessage(message, [])
      generated.push(prose)
      sections.push({ kind: "prose", id: prose.id, message: prose })
    }
    const last = generated.at(-1)
    if (last && message.error) last.error = message.error
  }
  placeNotes(messages.length)
  flushWork()
  return sections
}

export function toExchanges(
  messages: ChatMessage[],
  previous: Exchange[] = []
): Exchange[] {
  const exchanges: Exchange[] = []
  const prompts = new Map<string, Exchange>()
  let current: Exchange | null = null

  for (const message of messages) {
    if (message.role === "user") {
      const steered = message.steeringFor
        ? prompts.get(message.steeringFor)
        : undefined
      if (steered) {
        steered.response.push(message)
        continue
      }
      if (message.steeringFor) {
        // Its question may be on an earlier page. Keep a steer in the answer
        // until that page arrives; it must not become a new question.
        let leading = exchanges[0]?.id === LEAD_EXCHANGE_ID ? exchanges[0] : undefined
        if (!leading) {
          leading = { id: LEAD_EXCHANGE_ID, response: [], system: [] }
          exchanges.unshift(leading)
        }
        current ??= leading
        leading.response.push(message)
        continue
      }
      current = {
        id: message.id,
        prompt: message,
        response: [],
        system: [],
        timestamp: message.timestamp,
      }
      exchanges.push(current)
      prompts.set(message.id, current)
      continue
    }

    if (!current) {
      // The agent spoke first — a resumed session, or a system note before any
      // prompt. It still needs somewhere to live.
      current = {
        id: LEAD_EXCHANGE_ID,
        response: [],
        system: [],
        timestamp: message.timestamp,
      }
      exchanges.push(current)
    }

    if (message.role === "system")
      current.system.push({ message, after: current.response.length })
    else current.response.push(message)
  }

  const byId = new Map(previous.map((exchange) => [exchange.id, exchange]))
  return exchanges.map((exchange) => {
    const old = byId.get(exchange.id)
    return old &&
      old.prompt === exchange.prompt &&
      old.response.length === exchange.response.length &&
      old.system.length === exchange.system.length &&
      old.response.every(
        (message, index) => message === exchange.response[index]
      ) &&
      old.system.every(
        (note, index) =>
          note.message === exchange.system[index]!.message &&
          note.after === exchange.system[index]!.after
      )
      ? old
      : exchange
  })
}

/** Everything the agent said in an exchange, as plain text for the clipboard. */
export function responseText(exchange: Exchange): string {
  return exchange.response
    .filter((message) => message.role === "assistant")
    .map((message) => textOf(message.blocks))
    .filter(Boolean)
    .join("\n\n")
}

/** A one-line label for the navigator and the jump list. */
export function promptLabel(exchange: Exchange): string {
  const text = exchange.prompt ? textOf(exchange.prompt.blocks) : ""
  const line = text.replace(/\s+/g, " ").trim()
  if (line) return line
  return exchange.response.length > 0 ? "Agent turn" : "Empty turn"
}
