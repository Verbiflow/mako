import type { FinReportCard } from "@mako/host/contracts/fin-reports"
import type { EventTone } from "@mako/sessions/events"
import type { ChatMessage } from "@/lib/types"
import type { PlacedSection } from "@/lib/exchanges"
import { formatDuration } from "@/lib/format"
import { reportsPhrase, reportStays } from "@/lib/fin-report-words"
import { makoCallWords, pairTools, summarizeToolWork, type ToolWorkSummary } from "@/lib/tools"
import { workHeadline } from "@/lib/work-headline"
import type { ToolCall } from "@/extend/slots"
import { eventWords } from "@/lib/transcript-events"

/**
 * One thing a turn holds besides its prompt, in the order it happened. What opened it where a prompt would stand,
 * when that isn't a message: a report its wake carried (`report`; `open` while the roster still holds its decision
 * open) or a line of Mako's or the provider's (`line`). Then each section of its answer, with its place among them
 * (`index`; a note that landed before any answer has -1).
 */
export type TurnEntry =
  | { kind: "report"; id: string; card: FinReportCard; open: boolean }
  | { kind: "line"; id: string; title: string; tone?: EventTone }
  | { kind: "section"; id: string; index: number; section: PlacedSection }

export type ReportEntry = Extract<TurnEntry, { kind: "report" }>

/** One phrase of a fold's line, and what it speaks for. */
export interface FoldPart {
  kind: "reports" | "line" | "notices" | "sent" | "more" | "worked"
  text: string
}

/**
 * Everything between two messages that isn't one, behind one line worded from its parts ("Docs pass finished ·
 * worked for 48s"). `members` is all of it in order, drawn as each draws on its own once the line is opened; `kept`
 * are the members that stay drawn under the closed line because they want the person (`stillDrawn`).
 */
export interface FoldRow {
  kind: "fold"
  id: string
  /** Which stretch of the turn it folds: 0 before any steer, then one more after each. */
  part: number
  parts: FoldPart[]
  /** The line's words, its parts joined; undefined when nothing words it and the row falls back to what the work did. */
  title?: string
  members: TurnEntry[]
  kept: TurnEntry[]
  /** Something inside ended badly and nothing later put it right: the line stands out until it's read. */
  needs: boolean
  /** It follows a steer, so its time reads as "continued for". */
  continued: boolean
  /** The turn still runs or failed: the line holds only what opened it, and its work is drawn under it as it goes. */
  head: boolean
  /** When the stretch began: the prompt, or the steer that continued it. */
  from?: number
  worked?: number
  /** The messages it hides: what its row counts. */
  messages: ChatMessage[]
  work: ToolWorkSummary
  /** What its calls did, in words: Mako's own tools in theirs ("Messaged Sheet motion · started fin:docs"), the rest by kind. */
  did?: string
}

/**
 * A turn as the transcript draws it, top to bottom: a message as it is, a report that needs someone as its own
 * block, and one fold for the rest of each stretch.
 */
export type TurnRow =
  | { kind: "message"; id: string; entry: TurnEntry }
  | { kind: "report"; id: string; entry: ReportEntry }
  | FoldRow

export interface TurnRowsInput {
  /** What opened the turn besides a person's prompt, in order (`TurnEntry`'s `report` and `line`, and notes at -1). */
  opening?: readonly TurnEntry[]
  sections: readonly PlacedSection[]
  /** When the turn began: its prompt, or what opened it. */
  began?: number
  /** `head`: the turn still runs, or failed and shows all it did. Only what opened it folds. */
  mode?: "settled" | "head"
  /** How the turn was cut, for its last stretch's words: the person's own stop, or one that happened to it. */
  stop?: "chosen" | "cut"
}

/**
 * What a fold never hides, because the person reads or acts on it: what the agent showed them or made for them,
 * where their own message went (an Apex's own message to a Fin folds: its call's row says it), a turn that went on
 * past a dropped connection or a lost machine, and a note that wants attention: a failure, a warning, a usage
 * limit, a stop. A compaction, a model change, background work that settled and every ambient notice fold into the
 * line, which words them.
 */
export function stillDrawn(section: PlacedSection): boolean {
  // What the person is told of a turn that went on past a dropped connection stays said, so its next steps read right.
  if (section.kind === "shown" || section.kind === "made" || section.kind === "resumed") return true
  if (section.kind === "routed") return Boolean(section.routed.forward || section.routed.direct)
  // A step the loss of a machine undid changes the person's files; where the turn picked it up again stays said.
  if (section.kind === "continued") return section.continued.reason === "machine-lost"
  if (section.kind !== "note") return false
  const note = section.message.note
  if (!note) return false
  if (note.limit) return true
  const words = eventWords(note)
  return Boolean(words.tone) || words.glyph === "stop" || words.glyph === "limit"
}

function messagesOf(section: PlacedSection): ChatMessage[] {
  return section.kind === "work" ? section.messages : section.kind === "shown" || section.kind === "made" || section.kind === "routed" || section.kind === "continued" || section.kind === "resumed" ? [] : [section.message]
}

/** The time `sections` worked from `from`: each part's start to its last message, a continuation starting the next part. */
function workedFor(sections: readonly PlacedSection[], from: number | undefined): number | undefined {
  let worked: number | undefined
  let start = from
  let last: number | undefined
  const settle = () => {
    if (start !== undefined && last !== undefined && last >= start) worked = (worked ?? 0) + last - start
  }
  for (const section of sections) {
    if (section.kind === "continued") {
      settle()
      start = section.message.timestamp
      last = undefined
      continue
    }
    for (const message of messagesOf(section)) if (message.timestamp !== undefined) last = message.timestamp
  }
  settle()
  return worked
}

/** A section that answers: the agent's words, what it showed the person or made for them, or where it sent their message. */
const answers = (section: PlacedSection) => section.kind === "prose" || section.kind === "shown" || section.kind === "made" || section.kind === "routed"

/** The most phrases a line says before its time. */
const PHRASES = 3

const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

/** Whether an entry stays drawn while the fold over it is closed. */
function stays(entry: TurnEntry): boolean {
  if (entry.kind === "report") return reportStays(entry.card, entry.open)
  if (entry.kind === "line") return Boolean(entry.tone)
  return stillDrawn(entry.section)
}

/** The line's phrases for `hidden`, at most `PHRASES`: its reports, what opened it, where it wrote, then its notices. */
function partsOf(hidden: readonly TurnEntry[]): FoldPart[] {
  const parts: FoldPart[] = []
  const cards = hidden.flatMap((entry) => (entry.kind === "report" ? [entry.card] : []))
  if (cards.length) parts.push({ kind: "reports", text: reportsPhrase(cards) })
  for (const entry of hidden) if (entry.kind === "line") parts.push({ kind: "line", text: entry.title })
  const sent = hidden.flatMap((entry) => (entry.kind === "section" && entry.section.kind === "routed" ? [entry.section.routed.to] : []))
  if (sent.length) parts.push({ kind: "sent", text: sent.length === 1 ? `Sent a message to ${sent[0]}` : `Sent ${sent.length} messages` })
  const notices = hidden.flatMap((entry) => {
    const note = entry.kind === "section" && entry.section.kind === "note" ? entry.section.message.note : undefined
    return note ? [eventWords(note).title] : []
  })
  // Each notice in its own words while the line has room; past that they are counted.
  if (notices.length && parts.length + notices.length <= PHRASES) parts.push(...notices.map((text): FoldPart => ({ kind: "notices", text })))
  else if (notices.length) parts.push({ kind: "notices", text: `${notices.length} notices` })
  if (parts.length <= PHRASES) return parts
  return [...parts.slice(0, PHRASES - 1), { kind: "more", text: `${parts.length - PHRASES + 1} more` }]
}

/**
 * What a stretch's calls did, as its line says it. Calls of Mako's own server say what they did in their own words
 * (`makoToolWords`: "Messaged Sheet motion on iPad", "Opened PR #374"), so a stretch that is only those names the
 * first two and counts the rest, never "used 3 other tools". Anything else is counted by kind (`workHeadline`).
 */
function didWords(calls: readonly ToolCall[], work: ToolWorkSummary): string | undefined {
  if (!calls.length) return undefined
  const own = calls.map((call) => (call.isError ? undefined : makoCallWords(call)?.done))
  if (own.every((words) => words !== undefined)) {
    const said = [...new Set(own)]
    const shown = said.length > PHRASES ? said.slice(0, PHRASES - 1) : said
    const rest = said.length - shown.length
    return [...shown.map((words, index) => (index ? lower(words) : words)), ...(rest ? [`${rest} more ${rest === 1 ? "step" : "steps"}`] : [])].join(" · ")
  }
  return workHeadline(work).did.join(" · ") || undefined
}

function titleOf(parts: readonly FoldPart[]): string | undefined {
  if (!parts.length) return undefined
  return parts.map((part, index) => (index && (part.kind === "worked" || part.kind === "sent" || part.kind === "more") ? lower(part.text) : part.text)).join(" · ")
}

/**
 * The rows of one turn (`TurnRow`). Each stretch (the turn, cut at every steer) folds everything on the way to its
 * answer behind one line: its work, the words between the work, the reports and lines that opened it, its notices.
 * A stretch with no work folds only when a line saves rows: it holds a report, or two lines or more, and no words.
 * What needs someone never folds: such a report stands before the line as its own block, and anything else that
 * wants the person stays drawn under the closed line (`kept`). The answer, a steer, and what the agent showed or
 * made are messages. In `head` mode nothing but what opened the turn folds, so the line a wake's reports stand
 * behind is already there while the turn runs, and takes the work in when it settles without moving.
 */
export function turnRows({ opening = [], sections, began, mode = "settled", stop }: TurnRowsInput): TurnRow[] {
  const rows: TurnRow[] = []
  const message = (entry: TurnEntry): TurnRow => ({ kind: "message", id: entry.id, entry })
  const entryOf = (index: number): TurnEntry => ({ kind: "section", id: sections[index]!.id, index, section: sections[index]! })
  const steers = sections.filter((section) => section.kind === "steer").length
  /** Rows for the stretch `sections[start, end)`; `lead` is what opened the turn, for its first stretch. */
  const close = (part: number, start: number, end: number, lead: readonly TurnEntry[], from: number | undefined, continued: boolean) => {
    const head = mode === "head"
    let answer = end
    if (head) answer = start
    else {
      while (answer > start && sections[answer - 1]!.kind === "note") answer--
      if (answer > start && answers(sections[answer - 1]!)) while (answer > start && answers(sections[answer - 1]!)) answer--
      else answer = end
    }
    const span = Array.from({ length: answer - start }, (_, offset) => entryOf(start + offset))
    const worked = span.some((entry) => entry.kind === "section" && entry.section.kind === "work")
    const members = [...lead, ...span]
    // A report that needs someone stands before the line, where the wake set it.
    const standing = lead.filter((entry): entry is ReportEntry => entry.kind === "report" && stays(entry))
    const inside = members.filter((entry) => !(entry.kind === "report" && standing.includes(entry)))
    const hidden = inside.filter((entry) => !stays(entry))
    const worded = span.some((entry) => entry.kind === "section" && (entry.section.kind === "prose" || entry.section.kind === "steer"))
    const folds = worked || (!worded && (hidden.some((entry) => entry.kind === "report") || hidden.length > 1))
    if (!folds) {
      for (const entry of lead) rows.push(entry.kind === "report" ? { kind: "report", id: entry.id, entry } : message(entry))
      for (let index = start; index < end; index++) rows.push(message(entryOf(index)))
      return
    }
    for (const entry of standing) rows.push({ kind: "report", id: entry.id, entry })
    const messages = span.flatMap((entry) => (entry.kind === "section" ? messagesOf(entry.section) : []))
    const calls = messages.flatMap((each) => pairTools(each.blocks))
    const work = summarizeToolWork(calls, messages.find((each) => each.provider)?.provider)
    const did = didWords(calls, work)
    const time = head ? undefined : workedFor(sections.slice(start, end), from)
    const parts = partsOf(hidden)
    const cut = part === steers ? stop : undefined
    if (time !== undefined || cut) {
      const verb = cut ? (cut === "chosen" ? "Stopped" : "Interrupted") : continued ? "Continued" : "Worked"
      parts.push({ kind: "worked", text: time === undefined ? verb : `${verb} ${cut ? "after" : "for"} ${formatDuration(time)}` })
    }
    rows.push({
      kind: "fold", id: `fold-${part}`, part, parts, title: titleOf(parts), members: inside, kept: inside.filter(stays),
      needs: work.failed > 0 || work.cutOff > 0, continued, head, from, ...(did && { did }), ...(time !== undefined && { worked: time }), messages, work,
    })
    for (let index = answer; index < end; index++) rows.push(message(entryOf(index)))
  }
  let start = 0
  let from = began
  let part = 0
  for (const [index, section] of sections.entries()) {
    if (section.kind !== "steer") continue
    close(part, start, index, part === 0 ? opening : [], from, part > 0)
    rows.push(message(entryOf(index)))
    part += 1
    start = index + 1
    from = section.message.timestamp
  }
  close(part, start, sections.length, part === 0 ? opening : [], from, part > 0)
  return rows
}
