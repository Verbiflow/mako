import type { Block, ChatMessage } from "@/lib/types"
import { mergeMedia, type MediaCandidate } from "@mako/sessions/turn-media"
import { textOf } from "@/lib/format"
import { causeWords, eventLabel, foldLimitMoves } from "@/lib/transcript-events"
import { foldUsageLimits } from "@/lib/usage-limit-folds"
import { opensContinuation, savedContinuation, type SavedContinuation } from "@mako/host/contracts/turn-continuation"
import { savedResumeAccount } from "@mako/host/contracts/resume-account"
import { routedAnswer, routedCall, type Routed, type RoutedAnswer } from "@mako/host/contracts/children"

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
  /** A retained Mako request when proven, otherwise the opening message ID. Native anchors stay separate. */
  id: string
  /** A released body keeps its navigator label and place until it reloads. */
  unloaded?: string
  /** The user's message, absent for anything the agent said unprompted. */
  prompt?: ChatMessage
  /**
   * For a turn the provider started itself, what it reported as the cause
   * (a background command finishing). Never set together with `prompt`.
   */
  opener?: ChatMessage
  /**
   * The person's message sent from an Apex's conversation straight to one
   * of its Fins (`note.direct`): its own exchange, with no answer, since no
   * turn of the Apex's ran for it. Never set together with `prompt`.
   */
  direct?: ChatMessage
  /**
   * Everything after the prompt, in order: assistant and tool messages, any
   * message the user steered in while the agent was still working, and each
   * continuation that picked the turn up after it was cut short
   * (`isContinuation`). A steer stays where it landed — after the work it
   * interrupted, before the work it redirected — never hoisted next to the
   * prompt; a continuation stays where the turn went on.
   */
  response: ChatMessage[]
  /** Notes and separators that landed inside this exchange, in order. */
  system: ExchangeNote[]
  /**
   * The turns the provider started on its own that a usage limit this
   * exchange reported refused, by the id of the note that reported it:
   * each turn's opener, in order (`foldUsageLimits`).
   */
  refused?: Readonly<Record<string, readonly ChatMessage[]>>
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
  | { kind: "prose"; id: string; message: ChatMessage; previewedFiles?: readonly string[] }
  | { kind: "work"; id: string; messages: ChatMessage[] }
  | { kind: "steer"; id: string; message: ChatMessage }
  /**
   * Where a turn cut short went on: Mako's words to the agent, sent by Mako
   * or by the person's Continue turn (`isContinuation`), and what they say
   * of why and who. Not the person's words, so never drawn as theirs.
   */
  | { kind: "continued"; id: string; message: ChatMessage; continued: SavedContinuation }
  /**
   * Where the turn went on from a point older than calls it had already run,
   * and the agent was told of them (`resumeAccountText`): Mako's words, read
   * by their header live and saved alike, drawn as one quiet line.
   */
  | { kind: "resumed"; id: string; message: ChatMessage; resumed: ResumedAccount }
  | { kind: "note"; id: string; message: ChatMessage }
  /**
   * What the agent put in front of the person with `show`, drawn where the
   * call stands rather than in its work: the call's row stays in the work,
   * and `message` (no blocks of its own) is the reply it came in.
   */
  | { kind: "shown"; id: string; message: ChatMessage; media: MediaCandidate[] }
  /**
   * Where an Apex sent a message (`agents_send`), drawn where the call
   * returned, as `shown` is: the call's row stays in the work. `landed` is
   * where its answer says it went, when the result kept it.
   */
  | { kind: "routed"; id: string; message: ChatMessage; routed: Routed; landed?: RoutedAnswer }

/**
 * An answer's sections as the exchange draws them: its own, and what the
 * turn made that neither `show` nor its words put in front of the person,
 * in the flow: after the stretch of work whose call made it, or at the end
 * of the answer for a file only the turn's record of changes names
 * (`placeMadeMedia` in `media-shelf.ts`).
 */
export type PlacedSection = ResponseSection | { kind: "made"; id: string; media: MediaCandidate[] }

/**
 * What a prompt says when it is Mako's continuation of a turn cut short,
 * known by its words alone (`savedContinuation`), the same live and saved:
 * Mako's own sends and the person's Continue turn send the same kind of
 * words, and a saved history keeps nothing else. A steer is never one.
 */
export function isContinuation(message: ChatMessage): SavedContinuation | undefined {
  if (message.role !== "user" || message.steeringFor) return undefined
  // Asked of every prompt as the projection runs: a prompt that doesn't open as one is never read whole.
  const first = message.blocks.find((block) => block.type === "text" && block.text)
  return first?.type === "text" && opensContinuation(first.text) ? savedContinuation(textOf(message.blocks)) : undefined
}

export type ResumedAccount = NonNullable<ReturnType<typeof savedResumeAccount>>

/** What a message says when it is Mako's account of calls a resumed turn had already run, known by its header. */
export function resumedAccount(message: ChatMessage): ResumedAccount | undefined {
  if (message.role !== "user") return undefined
  const first = message.blocks.find((block) => block.type === "text" && block.text)
  return first?.type === "text" ? savedResumeAccount(first.text) : undefined
}

/** A user message that is part of the turn it joined, never a request of its own: a steer, or a resume account. */
function joinsTurn(message: ChatMessage): boolean {
  return Boolean(message.steeringFor) || resumedAccount(message) !== undefined
}

/** The requests an exchange's turn ran as: its prompt's, then each continuation's, in order. */
export function exchangeRequests(exchange: Exchange): string[] {
  const ids: string[] = []
  if (exchange.prompt?.requestId) ids.push(exchange.prompt.requestId)
  for (const message of exchange.response)
    if (message.role === "user" && !joinsTurn(message) && message.requestId) ids.push(message.requestId)
  return ids
}

/**
 * The request the turn stands on now: its newest continuation's, else its
 * prompt's. How the turn ended (stopped, failed, still to be picked up) is
 * that request's; an earlier part's stop was superseded when it went on.
 */
export function turnRequest(exchange: Exchange): string | undefined {
  for (let index = exchange.response.length - 1; index >= 0; index--) {
    const message = exchange.response[index]!
    if (message.role === "user" && !joinsTurn(message)) return message.requestId
  }
  return exchange.prompt?.requestId
}

/** How many response messages come before the turn's newest continuation: the part the turn stands on starts there. */
export function continuedFrom(exchange: Pick<Exchange, "response">): number {
  for (let index = exchange.response.length - 1; index >= 0; index--) {
    const message = exchange.response[index]!
    if (message.role === "user" && !joinsTurn(message)) return index + 1
  }
  return 0
}

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

/**
 * The notes a continued turn shows: the provider's own stop marker right
 * where the turn went on said only that the part before it was cut short,
 * which the turn going on supersedes.
 */
export function notesBesideContinuations(notes: readonly ExchangeNote[], response: readonly ChatMessage[]): readonly ExchangeNote[] {
  const kept = notes.filter((note) => {
    const next = response[note.after]
    return !isInterruptedNote(note.message) || next?.role !== "user" || Boolean(next.steeringFor)
  })
  return kept.length === notes.length ? notes : kept
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
      const resumed = resumedAccount(message)
      const continued = resumed ? undefined : isContinuation(message)
      sections.push(
        resumed ? { kind: "resumed", id: message.id, message, resumed }
          : continued ? { kind: "continued", id: message.id, message, continued }
            : { kind: "steer", id: message.id, message }
      )
      continue
    }
    const generated: ChatMessage[] = []
    // Splitting attachment/text blocks for layout must retain their shared
    // message provenance. Do not borrow visuals from another reply or turn.
    const previewed = message.blocks.flatMap(block =>
      block.type === "attachment" && block.source.kind === "file" ? [block.source.path] : []
    )
    const previewedFiles = previewed.length > 0 ? previewed : undefined
    let workBlocks: Block[] = []
    const flushMessageWork = () => {
      if (workBlocks.length === 0) return
      const split = splitMessage(message, workBlocks)
      work.push(split)
      generated.push(split)
      workBlocks = []
    }

    let attachmentProse: ChatMessage | undefined
    const routes = new Map<string, Routed>()
    for (const block of message.blocks) {
      if (block.type === "attachment" && attachmentProse) {
        attachmentProse.blocks.push(block)
        continue
      }
      attachmentProse = undefined
      if (
        message.role === "assistant" &&
        ((block.type === "text" && block.text) ||
          block.type === "attachment" ||
          block.type === "proposed-plan")
      ) {
        flushMessageWork()
        flushWork()
        const prose = splitMessage(message, [block])
        if (block.type === "attachment") attachmentProse = prose
        generated.push(prose)
        sections.push({ kind: "prose", id: prose.id, message: prose, previewedFiles })
      } else {
        workBlocks.push(block)
        const routed = block.type === "toolCall" ? routedCall(block) : undefined
        if (routed && block.type === "toolCall" && block.id) routes.set(block.id, routed)
        const route = block.type === "toolResult" && block.id && !block.isError && !block.isCanceled && !block.streaming ? routes.get(block.id) : undefined
        if (route && block.type === "toolResult" && !block.text.startsWith("refused:")) {
          flushMessageWork()
          flushWork()
          const landed = routedAnswer(block.text)
          sections.push({ kind: "routed", id: `routed-${block.id}`, message: splitMessage(message, []), routed: route, ...(landed && { landed }) })
        }
        const shown = block.type === "toolResult" ? block.media?.filter((media) => media.evidence === "shown") : undefined
        if (shown?.length && block.type === "toolResult") {
          flushMessageWork()
          flushWork()
          const at = splitMessage(message, [])
          sections.push({ kind: "shown", id: `shown-${block.id ?? at.id}`, message: at, media: shown })
        }
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

/** Takes the setup notes an exchange ends on, after all of its answer. */
function openingNotes(exchange: Exchange): ExchangeNote[] {
  let start = exchange.system.length
  while (start > 0) {
    const note = exchange.system[start - 1]!
    if (note.after < exchange.response.length || !note.message.note?.setup) break
    start--
  }
  return exchange.system.splice(start)
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
      // Mako's words picking up a turn that was cut short are not a new
      // question: the turn on screen goes on, as one turn. One whose turn is
      // on an earlier page goes on the exchange that stands in for it. A
      // resume account joins its turn the same way, live (as a steer
      // nothing matched) and saved.
      const resumed = resumedAccount(message) !== undefined
      if (resumed) {
        if (!current) {
          current = { id: LEAD_EXCHANGE_ID, response: [], system: [], timestamp: message.timestamp }
          exchanges.push(current)
        }
        current.response.push(message)
        continue
      }
      if (isContinuation(message)) {
        if (!current) {
          current = { id: LEAD_EXCHANGE_ID, response: [], system: [], timestamp: message.timestamp }
          exchanges.push(current)
        }
        current.response.push(message)
        prompts.set(message.id, current)
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
      // A cause nothing answered was delivered with this prompt, as Claude
      // does with a notification queued behind it; it belongs to this turn.
      const folded: Exchange | undefined =
        current?.opener && current.response.length === 0 && exchanges.at(-1) === current
          ? exchanges.pop()
          : undefined
      // What a session said as it opened (servers that did not start) is
      // about the prompt it opened for, whichever side of that prompt the
      // harness reported it on: never the end of the answer before it.
      const opening: ExchangeNote[] = !folded && current && exchanges.at(-1) === current ? openingNotes(current) : []
      if (current && opening.length && current.id === LEAD_EXCHANGE_ID && !current.response.length && !current.system.length)
        exchanges.pop()
      current = {
        id: message.requestId ? `acp-request-${message.requestId}` : message.id,
        prompt: message,
        response: [],
        system: folded?.opener
          ? [{ message: folded.opener, after: 0 }, ...folded.system]
          : opening.map((note) => ({ message: note.message, after: 0 })),
        timestamp: message.timestamp,
      }
      exchanges.push(current)
      prompts.set(message.id, current)
      continue
    }

    // The Apex's turn, if one runs, goes on in its own exchange: this one never answers.
    if (message.role === "system" && message.note?.direct) {
      exchanges.push({ id: message.id, direct: message, response: [], system: [], timestamp: message.timestamp })
      continue
    }

    if (message.role === "system" && message.opensTurn) {
      if (current && current.id !== LEAD_EXCHANGE_ID && current.response.length === 0) {
        current.system.push({ message, after: 0 })
        continue
      }
      current = {
        id: message.id,
        opener: message,
        response: [],
        system: [],
        timestamp: message.timestamp,
      }
      exchanges.push(current)
      continue
    }

    if (!current) {
      // The agent spoke first — a resumed session, or a system note before any
      // prompt. It still needs somewhere to live; after a direct message,
      // which is no prompt, it isn't the leading exchange.
      current = {
        id: exchanges.length ? message.id : LEAD_EXCHANGE_ID,
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
  return foldLimitMoves(foldUsageLimits(exchanges)).map((exchange) => {
    const old = byId.get(exchange.id)
    return old &&
      old.prompt === exchange.prompt &&
      old.opener === exchange.opener &&
      old.direct === exchange.direct &&
      old.response.length === exchange.response.length &&
      old.system.length === exchange.system.length &&
      old.response.every(
        (message, index) => message === exchange.response[index]
      ) &&
      old.system.every(
        (note, index) =>
          note.message === exchange.system[index]!.message &&
          note.after === exchange.system[index]!.after
      ) &&
      sameRefused(old.refused, exchange.refused)
      ? old
      : exchange
  })
}

function sameRefused(left: Exchange["refused"], right: Exchange["refused"]): boolean {
  if (left === right) return true
  if (!left || !right) return false
  const keys = Object.keys(right)
  return (
    keys.length === Object.keys(left).length &&
    keys.every((key) => left[key]?.length === right[key]!.length && left[key]!.every((opener, index) => opener === right[key]![index]))
  )
}

function promptWords(exchange: Exchange): string {
  return exchange.prompt ? textOf(exchange.prompt.blocks).replace(/\s+/g, " ").trim() : ""
}

/** Below this length a prompt inside another is chance ("yes", "continue"), not the same prompt retold. */
const RETOLD_MIN = 24
/** Retelling is a visual fallback; never scan an entire history for every new prompt. */
const RETOLD_LOOKBEHIND = 64

function samePrompt(left: string, right: string): boolean {
  if (left === right) return left !== ""
  const [shorter, longer] = left.length < right.length ? [left, right] : [right, left]
  return shorter.length >= RETOLD_MIN && longer.includes(shorter)
}

/**
 * The turns that came back under another id, by their old id. A host
 * checkpoint hands a finished conversation to its native history, whose
 * messages have the provider's ids, so a covered range can be renamed; the
 * native record can also add or drop a prompt, and retell one with its
 * attachments or spacing written differently. Prompts are matched in order,
 * by their words; equal-sized gaps use positional layout continuity. This is
 * best-effort presentation only. It is never native correspondence, fork,
 * replay, deduplication or execution-ownership evidence. Proven request IDs
 * are supplied upstream from retained native receipts instead.
 */
export function renamedExchanges(before: readonly Exchange[], after: readonly Exchange[]): Map<string, string> {
  const renamed = new Map<string, string>()
  const kept = new Set(after.map((exchange) => exchange.id))
  const gone = before.filter((exchange) => !kept.has(exchange.id))
  if (gone.length === 0) return renamed
  const had = new Set(before.map((exchange) => exchange.id))
  const arrived = after.filter((exchange) => !had.has(exchange.id))
  if (arrived.length === 0) return renamed
  const goneWords = gone.map(promptWords)
  const exact = new Map<string, number[]>()
  goneWords.forEach((words, index) => {
    if (!words) return
    const positions = exact.get(words)
    if (positions) positions.push(index)
    else exact.set(words, [index])
  })
  const matches: [number, number][] = []
  let floor = gone.length
  for (let next = arrived.length - 1; next >= 0 && floor > 0; next -= 1) {
    const words = promptWords(arrived[next]!)
    const positions = exact.get(words)
    while (positions?.length && positions.at(-1)! >= floor) positions.pop()
    let matched = positions?.at(-1)
    const lower = Math.max(0, floor - RETOLD_LOOKBEHIND, matched === undefined ? 0 : matched + 1)
    for (let old = floor - 1; old >= lower; old -= 1) {
      if (!samePrompt(goneWords[old]!, words)) continue
      matched = old
      break
    }
    if (matched !== undefined) {
      matches.push([matched, next])
      floor = matched
    }
  }
  matches.reverse()
  let from: [number, number] = [-1, -1]
  // SAFETY: The sentinel literal has exactly two numeric lengths, matching each tuple in matches.
  for (const to of [...matches, [gone.length, arrived.length] as [number, number]]) {
    const span = to[0] - from[0] - 1
    if (span > 0 && span === to[1] - from[1] - 1)
      for (let step = 1; step <= span; step += 1)
        renamed.set(gone[from[0] + step]!.id, arrived[from[1] + step]!.id)
    if (to[0] < gone.length) renamed.set(gone[to[0]]!.id, arrived[to[1]]!.id)
    from = to
  }
  return renamed
}

/**
 * The media an exchange's calls produced or showed (`callMedia` on each
 * call, merged as `turnMedia` merges a turn's entries): the same for a live
 * turn and the saved one, since both are drawn from entries.
 */
export function exchangeMedia(exchange: Exchange): MediaCandidate[] {
  const found: MediaCandidate[] = []
  for (const message of exchange.response)
    for (const block of message.blocks) if (block.type === "toolResult" && block.media) found.push(...block.media)
  return found.length ? mergeMedia(found) : []
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
/** The newest exchange a turn answers: what streams, stopped or failed. A direct message after it is no turn's. */
export function turnExchange(exchanges: readonly Exchange[]): Exchange | undefined {
  return exchanges.findLast((exchange) => !exchange.direct)
}

/** Each turn's label, by the turn: a stream renders the navigator again every batch, and its turns are kept as they were. */
const labels = new WeakMap<Exchange, string>()

export function promptLabel(exchange: Exchange): string {
  let label = labels.get(exchange)
  if (label === undefined) labels.set(exchange, (label = labelOf(exchange)))
  return label
}

function labelOf(exchange: Exchange): string {
  if (exchange.unloaded !== undefined) return exchange.unloaded
  const direct = exchange.direct?.note
  if (direct?.direct) return `To ${direct.direct.to}: ${(direct.body ?? "").replace(/\s+/g, " ").trim()}`
  const cause = !exchange.prompt ? exchange.opener?.note?.cause : undefined
  if (cause) return eventLabel(causeWords(cause))
  const opening = exchange.prompt ?? exchange.opener
  const text = opening ? textOf(opening.blocks) : ""
  const line = text.replace(/\s+/g, " ").trim()
  if (line) return line
  return exchange.response.length > 0 ? "Agent turn" : "Empty turn"
}
