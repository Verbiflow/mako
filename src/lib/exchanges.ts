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
  /** Notes and separators that landed inside this exchange. */
  system: ChatMessage[]
  timestamp?: number
}

export type ResponseSection =
  | { kind: "prose"; id: string; message: ChatMessage }
  | { kind: "work"; id: string; messages: ChatMessage[] }
  | { kind: "steer"; id: string; message: ChatMessage }

export function responseSections(messages: ChatMessage[]): ResponseSection[] {
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

  for (const message of messages) {
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

    if (message.role === "system") current.system.push(message)
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
      old.system.every((message, index) => message === exchange.system[index])
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
