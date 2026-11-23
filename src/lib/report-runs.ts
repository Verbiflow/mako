import type { FinReportCard } from "@mako/host/contracts/fin-reports"
import { agentWords } from "@mako/host/contracts/children"
import type { ChatMessage } from "@/lib/types"
import { isContinuation, isInterruptedNote, type Exchange } from "@/lib/exchanges"
import { runPhrase } from "@/lib/fin-report-words"
import { textOf } from "@/lib/format"
import { stillDrawn } from "@/lib/turn-rows"
import { foldedPromptParts, savedMakoPrompt } from "@/state/prompt-delivery"

/**
 * The most an Apex says of its Fins' news for its turn to count as a remark on it, in characters: a sentence or
 * two. Past it the turn is an answer the person reads, and it stands as a turn of its own.
 */
export const REMARK_CHARS = 320

/** The fewest turns that read as a run: one alone is already a line and a sentence. */
const RUN_TURNS = 2

/** A prompt's reports, read once for the message: a stream rebuilds its turn every batch around the same prompt. */
const promptCards = new WeakMap<ChatMessage, readonly FinReportCard[] | null>()

function cardsOf(prompt: ChatMessage): readonly FinReportCard[] | undefined {
  let cards = promptCards.get(prompt)
  if (cards === undefined) {
    const text = textOf(prompt.blocks)
    // Its header first: every other prompt is the person's, and is read no further.
    const reports = prompt.steeringFor ? undefined : agentWords(text)?.reports
    const digest = reports?.length && !isContinuation(prompt) && !foldedPromptParts(text) && !savedMakoPrompt(text)
    promptCards.set(prompt, (cards = digest && reports ? reports : null))
  }
  return cards ?? undefined
}

/** Each turn's reports when it is a report turn, read once for the turn as it stands. */
const reportTurns = new WeakMap<Exchange, readonly FinReportCard[] | null>()

/**
 * The reports a turn was woken with when the turn is nothing but that: its prompt Mako's digest of its Fins'
 * reports (`readFinReports`), and its answer the Apex's remark on them, at most `REMARK_CHARS` of words, with
 * nothing in it the person acts on or reads for itself: no message of theirs steered in, nothing shown or made, no
 * plan or review, no call that failed, no notice a turn's own fold would keep drawn (`stillDrawn`). Undefined for
 * every other turn, the person's own above all.
 */
export function reportTurn(exchange: Exchange): readonly FinReportCard[] | undefined {
  let cards = reportTurns.get(exchange)
  if (cards === undefined) reportTurns.set(exchange, (cards = readReportTurn(exchange) ?? null))
  return cards ?? undefined
}

function readReportTurn(exchange: Exchange): readonly FinReportCard[] | undefined {
  if (!exchange.prompt || exchange.unloaded !== undefined || exchange.run || exchange.refused) return undefined
  const cards = cardsOf(exchange.prompt)
  if (!cards) return undefined
  for (const { message } of exchange.system)
    if (isInterruptedNote(message) || stillDrawn({ kind: "note", id: message.id, message })) return undefined
  let words = 0
  for (const message of exchange.response) {
    if ((message.role !== "assistant" && message.role !== "tool") || message.error || message.streaming) return undefined
    for (const block of message.blocks) {
      if (block.type === "text") words += block.text.trim().length
      else if (block.type === "toolResult") {
        if (block.isError || block.isCutOff || block.streaming || block.media?.length || block.details?.length) return undefined
      } else if (block.type !== "toolCall" && block.type !== "thinking") return undefined
      if (words > REMARK_CHARS) return undefined
    }
  }
  return cards
}

/**
 * `exchanges` with each run of report turns as one exchange (`Exchange.run`): the turns between two of the
 * person's messages that exist only because their Fins reported (`reportTurn`), `RUN_TURNS` or more in a row, so
 * a dozen reports through an afternoon are one row of the transcript, which windows, measures and names it as it
 * does any turn. `stands` says which turns stay their own whatever they hold: the one streaming, a stopped or
 * failed one.
 *
 * Costs a look-up a turn: a settled turn is the same object in every frame, and a run whose turns are the ones it
 * held is the same object too (`previous`), so a streamed token draws no row again. A run keeps the id it was
 * first given while that turn is still in it, so earlier history arriving above it remounts nothing. With no run
 * the list given is the list returned.
 */
export function foldReportRuns(exchanges: Exchange[], stands: (exchange: Exchange) => boolean, previous: readonly Exchange[] = []): Exchange[] {
  let folded: Exchange[] | undefined
  let held: Map<string, Exchange> | undefined
  const close = (start: number, end: number) => {
    if (end - start < RUN_TURNS) {
      if (folded) for (let index = start; index < end; index++) folded.push(exchanges[index]!)
      return
    }
    folded ??= exchanges.slice(0, start)
    if (!held) {
      held = new Map()
      for (const exchange of previous) for (const turn of exchange.run?.turns ?? []) held.set(turn.id, exchange)
    }
    const turns = exchanges.slice(start, end)
    const before = turns.map((turn) => held!.get(turn.id)).find((run) => run !== undefined)
    if (before?.run && before.run.turns.length === turns.length && before.run.turns.every((turn, index) => turn === turns[index])) {
      folded.push(before)
      return
    }
    const cards = turns.flatMap((turn) => reportTurn(turn) ?? [])
    const id = before && turns.some((turn) => turn.id === before.id) ? before.id : turns[0]!.id
    folded.push({ id, run: { turns, cards, label: runPhrase(cards) }, response: [], system: [], timestamp: turns[0]!.timestamp })
  }
  let start = -1
  for (let index = 0; index < exchanges.length; index++) {
    const exchange = exchanges[index]!
    const member = reportTurn(exchange) !== undefined && !stands(exchange)
    if (member) {
      if (start < 0) start = index
      continue
    }
    if (start >= 0) close(start, index)
    start = -1
    folded?.push(exchange)
  }
  if (start >= 0) close(start, exchanges.length)
  return folded ?? exchanges
}
