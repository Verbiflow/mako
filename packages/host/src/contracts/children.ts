import { REPORT_FOLLOW_UP_INSTRUCTIONS } from "./report-actions.js"
import { z } from "zod"
import { LISTED_AFTER, LISTED_FINS, LISTED_WAITING_ON, type ListedFin, type ListedFinState } from "@mako/protocol/thread-listing"
import { APEX_WORD, entryState, FIN_WORD, finsWord, LEGACY_APEX_WORD, waitingStateWords, type Brief, type ChildState } from "./agents.js"
import type { Block } from "./conversation-session.js"
import { CHILDREN_BINDING, isProviderWork, type FinAnswered, type FinAsk, type NativeAgent, type NativeAgentRoster, type WaitingOn } from "./native-agents.js"
import type { Waiting } from "@mako/protocol/attention"
import { isLimitAsk } from "./fin-fallback.js"
import { readFinReports, type FinReportCard } from "./fin-reports.js"

/** Who an agent's words in a Thread are from, as their header names them: a Fin's Apex, or an Apex's Fins (a digest of their reports). */
export const YOUR_APEX = `your ${APEX_WORD}`
export const YOUR_FINS = `your ${FIN_WORD}s`
/** How the headers of builds before the names said the same two: read, never written. */
const LEGACY_FROM: ReadonlyMap<string, string> = new Map([[`your ${LEGACY_APEX_WORD}`, YOUR_APEX], ["your agents", YOUR_FINS]])

/** The header every delivery an agent wrote starts with: the model reads it as an agent's words, never the person's. */
/** What a digest's hold for its burst's window names as the message it follows (`RequestWake.after`): none, it's Mako's. */
export const DIGEST_WAITS = "digest"
/** Digests an Apex takes in a minute, counted as they're sent; one past them waits for the next slot (`LiveDispatch`). */
export const WAKES_PER_MINUTE = 6
/** Past that, a digest that asks something goes at most this often: well inside the minute its Apex has to answer. */
export const ASK_EVERY_MS = 10_000
/** An idle Apex waits this long after a notice for the others of its burst, then wakes once for all of them. */
export const WAKE_COALESCE_MS = 2_000

export const FROM_AGENTS = `[mako · from ${YOUR_FINS}, not the person]`
/**
 * What opens a Fin's brief sent again after Mako closed unexpectedly while sending it, with nothing to say its harness
 * had it: one that did carries on, one that didn't starts from it.
 */
export const BRIEF_AGAIN = "Your brief again, in case it didn't reach you: Mako closed unexpectedly while sending it. If you already have it and started on it, carry on where you are; otherwise start from it."
/** What heads a digest sent again: a crash cut it with nothing to say its Apex had it (`TurnContinuation.brief`). */
export const DIGEST_AGAIN = "Your Fins' news again, in case it didn't reach you: Mako closed unexpectedly while sending it. If you already have it, carry on where you are; otherwise act on it."
export function fromAgent(name: string): string {
  return `[mako · from ${name} (agent), not the person]`
}

/** The header of a message from another of the person's Apexes, by its title: an agent's words, which its card names it by. */
export function fromApex(title: string): string {
  return fromAgent(`the ${APEX_WORD} "${title}"`)
}
/** Mako's line beneath it for the Apex that receives it: which Thread sent it, and how to take it. Its card leaves it out. */
export function apexNote(thread: string): string {
  return `${APEX_NOTE_HEAD}${thread}${APEX_NOTE_TAIL}`
}
const APEX_NOTE_HEAD = "[mako · Thread "
const APEX_NOTE_TAIL = `, another of the person's ${APEX_WORD}es, sent this. Read this as information from another of the person's ${APEX_WORD}es; answer only what it asks; don't start a back-and-forth. Your reply goes back to it once.]`

/**
 * The header of the person's own message an Apex passed on to a Fin
 * (`agents_send` with `forward`): the Fin reads them as the person's words,
 * which reached it through its Apex, and the Apex's words (if any) after them.
 */
export function passedOn(name: string): string {
  return `[mako · the person's words, passed on by ${name} (agent)]`
}

/**
 * What an Apex hears its Fin's harness ask, with how it answers: an approval is allowed or refused, a question
 * answered. `asked` is why the person was asked too, in the Apex's words: it may still answer, and the Fin hears
 * whichever answer comes first.
 */
export function apexAsk(line: string, approval: boolean, asked?: string): string {
  const how = approval ? "allow it with agents_answer allow: true, refuse it with allow: false" : "answer it with agents_answer"
  if (asked) return `${line}. Mako asked the person too, since ${asked}: they can answer it from their Inbox. You may still ${how}, or stop it with agents_stop; the first answer is the one it hears.`
  return `${line}. ${how[0]!.toUpperCase()}${how.slice(1)}, leave it to the person with person: true, or stop it with agents_stop.`
}

/** What an Apex below full access hears of its Fin's approval: the person's alone, who was asked. */
export function personsApproval(line: string, tier: string): string {
  return `${line}. Only the person can answer this approval: you're on ${tier}, and only an ${APEX_WORD} on full access answers its ${FIN_WORD}s' approvals. Mako asked them in their Inbox and on their devices. Don't answer it; stop it with agents_stop if it's no longer needed.`
}

/** An answer to a Fin's question, beneath its header: the question it answers, then the answer. */
export function answerText(question: string, answer: string): string {
  return `Your question: ${question}\nAnswer: ${answer}`
}
/** Between the person's words an Apex passed on and what it added. */
export const PASSED_ON_NOTE = `[mako · what ${YOUR_APEX} adds]`
const PASSED_ON_NOTES = [PASSED_ON_NOTE, `[mako · what your ${LEGACY_APEX_WORD} adds]`]
/** Beneath a message that reached a Fin by stopping the headless run it was in and resuming its session in Mako. */
export const HANDED_OVER_NOTE = "[mako · to deliver this, Mako stopped your run and resumed your session here: your last step may have been cut off mid-way. Check what you had in flight (a command half-finished, a file half-written), then carry on with this message taken into account.]"

const AGENT_HEADER = /^\[mako · from (.+?)(?: \(agent\))?, not the person\]\n?/
const PASSED_ON_HEADER = /^\[mako · the person's words, passed on by (.+?) \(agent\)\]\n?/

/** Whether words came from Mako or an agent rather than the person typing them: only those carry Mako's header. */
export function sentByMako(text: string): boolean {
  return AGENT_HEADER.test(text) || PASSED_ON_HEADER.test(text)
}

/** A brief's lines for its Fin alone, who it is and how it reports: the person's card of the brief leaves them out. */
export function briefIntro(name: string): string {
  return `You're fin:${name}${INTRO_TAIL}`
}
const INTRO_TAIL = `, a ${FIN_WORD}: another Thread, ${YOUR_APEX}, started you for one piece of work. It reads your reports, not this conversation. agents_list with scope crew shows it and the other ${FIN_WORD}s it started.`
/** The intro's tail before a Fin could read its crew. */
const EARLIER_INTRO_TAIL = `, a ${FIN_WORD}: another Thread, ${YOUR_APEX}, started you for one piece of work. It reads your reports, not this conversation.`
export const BRIEF_CLOSE = `When you finish, are blocked, or need a decision, call agents_report (from a shell, \`mako agents report\`). Ending your turn without one tells ${YOUR_APEX} how it ended.`
/** A brief's lines as builds before the names wrote them, still left out of its card. */
const LEGACY_INTRO = { head: "You're child:", tail: ", a Thread another Thread started to do one piece of work. It reads your reports, not this conversation." }
const LEGACY_BRIEF_CLOSE = `When you finish, are blocked, or need a decision, call agents_report (from a shell, \`mako agents report\`). Ending your turn without one tells your ${LEGACY_APEX_WORD} how it ended.`

/** What a Fin's first turn reads: who asked, as an agent's words, and everything it knows of the work. */
export function briefText(brief: Brief, name: string): string {
  const lines = [
    fromAgent(YOUR_APEX),
    briefIntro(name),
    "",
    brief.objective,
  ]
  if (brief.doneWhen?.length) lines.push("", "Done when:", ...brief.doneWhen.map((item) => `- ${item}`))
  if (brief.boundaries?.length) lines.push("", "Boundaries:", ...brief.boundaries.map((item) => `- ${item}`))
  if (brief.output) lines.push("", `Your report carries: ${brief.output}`)
  lines.push("", BRIEF_CLOSE, REPORT_FOLLOW_UP_INSTRUCTIONS)
  return lines.join("\n")
}

/** Whether `text` is a brief: it carries the line every brief ends on, as this build or an earlier one wrote it. */
export function isBrief(text: string): boolean {
  return text.includes(BRIEF_CLOSE) || text.includes(LEGACY_BRIEF_CLOSE)
}

/**
 * Words an agent wrote into a Thread (`fromAgent`, `FROM_AGENTS`), read from
 * their own header, so a saved transcript and a live one say the same: who
 * wrote them as the header names them (`YOUR_APEX`, `YOUR_FINS`, an earlier
 * build's words for either read as them), and the words after it, less a
 * brief's lines for its Fin alone and Mako's line beneath another Apex's
 * message (`apexNote`); for the person's own message an Apex passed
 * on, what it added. Undefined for the person's own words.
 */
export interface AgentWords {
  from: string
  body: string
  passedOn?: { added?: string }
  /** A wake's reports as data (`readFinReports`), each drawn as a message from its Fin; the body is then the Apex's alone. */
  reports?: FinReportCard[]
}

export function agentWords(text: string): AgentWords | undefined {
  const passed = PASSED_ON_HEADER.exec(text)
  if (passed) {
    const rest = text.slice(passed[0].length)
    const note = PASSED_ON_NOTES.find((candidate) => rest.includes(`\n\n${candidate}\n`))
    const [said, added] = note ? rest.split(`\n\n${note}\n`) : [rest]
    return { from: spoken(passed[1]!), body: said!.trim(), passedOn: { ...(added?.trim() && { added: added.trim() }) } }
  }
  const header = AGENT_HEADER.exec(text)
  if (!header) return undefined
  const { text: words, reports } = readFinReports(text)
  const body = words
    .slice(header[0].length)
    .split("\n")
    .filter((line) => line !== BRIEF_CLOSE && line !== REPORT_FOLLOW_UP_INSTRUCTIONS && line !== LEGACY_BRIEF_CLOSE && !briefIntroLine(line) && !(line.startsWith(APEX_NOTE_HEAD) && line.endsWith(APEX_NOTE_TAIL)))
    .join("\n")
    .trim()
  return { from: spoken(header[1]!), body, ...(reports.length && { reports }) }
}

function spoken(from: string): string {
  return LEGACY_FROM.get(from) ?? from
}

function briefIntroLine(line: string): boolean {
  return (line.startsWith("You're fin:") && (line.endsWith(INTRO_TAIL) || line.endsWith(EARLIER_INTRO_TAIL))) || (line.startsWith(LEGACY_INTRO.head) && line.endsWith(LEGACY_INTRO.tail))
}

/** A Fin's name as an agent may write it: `fin:<name>`, `child:<name>` as builds before the names taught it, or bare. */
export function finName(ref: string): string {
  return ref.startsWith("fin:") ? ref.slice("fin:".length) : ref.startsWith("child:") ? ref.slice("child:".length) : ref
}

type ToolCallBlock = Extract<Block, { type: "toolCall" }>

/**
 * A message that went from an Apex's conversation to a Fin, as its transcript
 * keeps it: the Apex's `agents_send` (to whom, and whether it passed on the
 * person's message), or the person's own written straight to the Fin with no
 * turn of the Apex's (`direct`).
 */
export interface Routed {
  to: string
  forward: boolean
  text?: string
  direct?: true
}

/**
 * A call on Mako's `mako` server that routed a message to a Fin, read from
 * the call itself (its server, its tool and its arguments, as every harness's
 * decoder names them), so a live turn and a saved one draw the same line.
 */
export function routedCall(block: ToolCallBlock): Routed | undefined {
  if (block.tool?.kind !== "mcp" || block.tool.server !== "mako" || block.tool.tool !== "agents_send") return undefined
  const call = RoutedCallSchema.safeParse(block.arguments)
  if (!call.success) return undefined
  const { to, forward, text } = call.data
  return { to: finName(to), forward: forward === true, ...(text?.trim() && { text: text.trim() }) }
}
const RoutedArgsSchema = z.looseObject({ to: z.string().min(1), forward: z.boolean().optional(), text: z.string().optional() })

/** An object's JSON, as a harness keeps a call's arguments and Mako writes its answers. */
const JsonObjectText = z.string().transform((text, context) => {
  try {
    if (text.trimStart().startsWith("{")) return JSON.parse(text)
  } catch {
    // Read as no object below.
  }
  context.addIssue({ code: "custom", message: "not an object's JSON" })
  return z.NEVER
})
const RoutedCallSchema = z.union([RoutedArgsSchema, JsonObjectText.pipe(RoutedArgsSchema)])

/** Where an `agents_send` landed, read from its result's text: undefined for a refusal, or a result a harness kept only in part. */
export function routedAnswer(text: string): RoutedAnswer | undefined {
  return JsonObjectText.pipe(RoutedAnswerSchema).safeParse(text).data
}
const RoutedAnswerSchema = z.object({ child: z.string(), request: z.string(), delivery: z.enum(["turn", "steer", "queued", "interrupt"]) })
export type RoutedAnswer = z.infer<typeof RoutedAnswerSchema>

/** What the person is shown a child as: the one reading `rollup`, the strip, the panel and the phone group it by. */
export type ChildGroup = "needs" | "working" | "queued" | "idle" | "failed" | "done"

/** The order children are listed in, everywhere: what needs the person first, so it never falls behind "+N". */
export const CHILD_GROUPS: readonly ChildGroup[] = ["needs", "working", "queued", "idle", "failed", "done"]

/**
 * A child entry's state: `childState`'s, as its entry carries it. An entry from
 * a host before `child.state` says only its roster state, which is read as
 * plainly as it can be: waiting is idle there, since it can't say on whom.
 */
export function childStateOf(agent: NativeAgent): ChildState {
  if (agent.child?.state) return agent.child.state
  switch (agent.state.kind) {
    case "working":
      return { kind: "working", ...(agent.state.activity && { step: agent.state.activity }) }
    case "waiting":
      return { kind: "idle" }
    case "completed":
      return { kind: "ended", outcome: "done" }
    case "canceled":
      return { kind: "ended", outcome: "stopped" }
    case "failed":
      return { kind: "ended", outcome: "failed", reason: agent.state.error }
    case "unknown":
      return { kind: "ended", outcome: "failed", reason: agent.state.reason }
  }
}

/**
 * Where a Fin stands for the person. A question on its Apex is the Apex's
 * to answer, so that Fin is still at work as far as the person goes, and one
 * that finished with a decision its Apex makes is done. An idle one has
 * nothing running and nothing asked, and is open for a next message, so it
 * is neither working nor done.
 */
export function childGroup(state: ChildState): ChildGroup {
  switch (state.kind) {
    case "queued":
      return "queued"
    case "starting":
    case "working":
      return "working"
    case "blocked":
      return state.on === "lead" ? "working" : "needs"
    case "idle":
      return "idle"
    case "ended":
      return state.outcome === "failed" || state.unfinished ? "failed" : state.decision?.on === "person" ? "needs" : "done"
  }
}

/** What a Fin waits on someone to answer, whatever its state: a blocked Fin's question or approval, or the decision a done one leaves. */
export interface OpenAsk {
  question: string
  on: "lead" | "person" | "approval"
  ask?: FinAsk
  /** It finished: what's asked is a decision its work leaves, not what it waits on to go on. */
  done?: true
}

export function openAsk(state: ChildState): OpenAsk | undefined {
  if (state.kind === "blocked") return { question: state.question, on: state.on, ...(state.ask && { ask: state.ask }) }
  if (state.kind === "ended" && state.decision) return { ...state.decision, done: true }
  return undefined
}

/** An approval's two answers as every surface says them: a harness's "Allow once" and "Refuse", or a named ask's own. */
export function approvalWords(ask: Pick<FinAsk, "named" | "options">) {
  const [allow, refuse] = ask.named ? (ask.options ?? []) : []
  return { allow: allow?.label ?? "Allow once", refuse: refuse?.label ?? "Refuse" }
}

/** How a done Fin's decision for the person reads, before its question: "Done · needs you: Merge #371?". */
export const DONE_NEEDS_YOU = "Done · needs you"

/** An open ask's words where the person reads it: its question, after `DONE_NEEDS_YOU` for a decision. */
export function askWords(ask: Pick<OpenAsk, "question" | "done">): string {
  return ask.done ? `${DONE_NEEDS_YOU}: ${ask.question}` : ask.question
}

/**
 * What a Fin's ask of the person makes its Apex's row, banner and mark say: the Fin's name before its line. A limit's
 * notice asks nothing and is no Fin's: it needs the person, and its line already says what ran out.
 */
export function finAskWaiting(ask: Pick<FinAsk, "id" | "kind">, name: string, line: string): Waiting {
  if (isLimitAsk(ask.id)) return { for: "needs-you", line }
  return { for: ask.kind === "approval" ? "approval" : "question", line: `${name}: ${line}` }
}

/**
 * Who answered a Fin's question, while it works on the answer: "You answered: Merge", "Apex answered: Merge". Answers
 * kept before their header was left off lose it here, and one with nothing else in it says nothing.
 */
export function answeredWords(answered: FinAnswered): string | undefined {
  const answer = (agentWords(answered.answer)?.body ?? answered.answer).trim()
  return answer ? `${answered.by === "person" ? "You" : APEX_WORD} answered: ${answer}` : undefined
}

type ListedWaitingOn = NonNullable<Extract<ListedFinState, { kind: "idle" }>["waitingOn"]>[number]

const FIN_NOTE = 200
const finNote = (text: string) => (text.length > FIN_NOTE ? `${text.slice(0, FIN_NOTE - 1)}…` : text)

const listedWaitingOn = (item: WaitingOn): ListedWaitingOn => {
  switch (item.kind) {
    case "pull-request":
      return { ...item, ref: finNote(item.ref) }
    case "person":
      return { kind: "person", what: finNote(item.what) }
    case "other":
      return { kind: "other", text: finNote(item.text) }
  }
}

/**
 * A Fin's state as its Apex's row says it: `ChildState` without a blocked Fin's ask or a done one's, which the row's
 * `asking` says, its words cut to a row's length. Each field is named, since what a new one is the gateway refuses.
 */
function listedFinState(state: ChildState): ListedFinState {
  switch (state.kind) {
    case "queued":
      return {
        kind: "queued",
        reason: state.reason,
        ahead: state.ahead,
        ...(state.after?.length && { after: state.after.slice(0, LISTED_AFTER).map(finNote) }),
        ...(state.held && { held: finNote(state.held) }),
        ...(state.refused && { refused: finNote(state.refused) }),
        ...(state.apexStopped && { apexStopped: true as const }),
      }
    case "working":
      return {
        kind: "working",
        ...(state.step && { step: finNote(state.step) }),
        ...(state.phase && { phase: finNote(state.phase) }),
        ...(state.answered && { answered: { by: state.answered.by, answer: finNote(state.answered.answer) } }),
      }
    case "blocked":
      return { kind: "blocked", question: finNote(state.question), on: state.on }
    case "ended":
      return {
        kind: "ended",
        outcome: state.outcome,
        ...(state.reason && { reason: finNote(state.reason) }),
        ...(state.unfinished && { unfinished: true as const }),
        ...(state.decision && { decision: { question: finNote(state.decision.question), on: state.decision.on } }),
      }
    case "starting":
      return { kind: "starting", step: state.step }
    case "idle":
      return {
        kind: "idle",
        ...(state.waitingOn?.length && { waitingOn: state.waitingOn.slice(0, LISTED_WAITING_ON).map(listedWaitingOn) }),
        ...(state.since !== undefined && { since: state.since }),
      }
  }
}

/**
 * An Apex's Fins as its row lists them for every other device (`ListedFin`, link version 19 on): its roster, in the
 * order every surface on its owner draws it. Undefined while it has none.
 */
export function listedFins(children: readonly NativeAgent[] | undefined): ListedFin[] | undefined {
  const fins = orderedChildren((children ?? []).filter((agent) => agent.child)).slice(0, LISTED_FINS).map((agent): ListedFin => ({
    thread: agent.child!.thread,
    name: finNote(agent.child!.name ?? agent.title ?? FIN_WORD),
    harness: agent.provider,
    ...(agent.title && agent.title !== agent.child!.name && { title: finNote(agent.title) }),
    state: listedFinState(childStateOf(agent)),
    startedAt: new Date(agent.startedAt ?? agent.observedAt).toISOString(),
  }))
  return fins.length ? fins : undefined
}

const childrenOfFins = new WeakMap<readonly ListedFin[], readonly NativeAgent[]>()

/**
 * The roster entries a row's Fins stand for, on a device that isn't their Apex's owner: the same selectors read them
 * (`rollup`, `pipsOf`, `childLine`), in `orderedChildren`' order, so every device counts, orders and names them as
 * the owner does. The same array while the row's Fins are.
 */
export function finsAsChildren(fins: readonly ListedFin[] | undefined): readonly NativeAgent[] {
  if (!fins?.length) return NO_CHILDREN
  const held = childrenOfFins.get(fins)
  if (held) return held
  const children = orderedChildren(fins.map((fin): NativeAgent => {
    const at = Date.parse(fin.startedAt)
    return {
      nativeId: `mako-child:${fin.thread}`,
      title: fin.title ?? fin.name,
      work: "agent",
      background: true,
      state: entryState(fin.state),
      bindingId: CHILDREN_BINDING,
      provider: fin.harness,
      observedAt: at,
      startedAt: at,
      child: { thread: fin.thread, name: fin.name, origin: "started", state: fin.state },
    }
  }))
  childrenOfFins.set(fins, children)
  return children
}

const NO_CHILDREN: readonly NativeAgent[] = []
const childrenOfRoster = new WeakMap<NativeAgentRoster, readonly NativeAgent[]>()

/** A roster's children, in the order `orderedChildren` gives: the same array while the roster is the same. */
export function rosterChildren(roster: NativeAgentRoster | undefined): readonly NativeAgent[] {
  if (!roster) return NO_CHILDREN
  const held = childrenOfRoster.get(roster)
  if (held) return held
  const children = roster.agents.some((agent) => !isProviderWork(agent)) ? orderedChildren(roster.agents.filter((agent) => !isProviderWork(agent))) : NO_CHILDREN
  childrenOfRoster.set(roster, children)
  return children
}

/** Children grouped in `CHILD_GROUPS`' order, the oldest first within each, as the strip's tabs and the panel's sections stand. */
export function orderedChildren(children: readonly NativeAgent[]): NativeAgent[] {
  const rank = (agent: NativeAgent) => CHILD_GROUPS.indexOf(childGroup(childStateOf(agent)))
  return [...children].sort((left, right) => rank(left) - rank(right) || (left.startedAt ?? left.observedAt) - (right.startedAt ?? right.observedAt))
}

/** How many of an Apex's Fins stand in each group: the rail's badge, the strip's count, the panel's headings and the phone's list. */
export interface Rollup {
  total: number
  needs: number
  working: number
  queued: number
  idle: number
  failed: number
  done: number
}

const EMPTY_ROLLUP: Rollup = { total: 0, needs: 0, working: 0, queued: 0, idle: 0, failed: 0, done: 0 }
const rollups = new WeakMap<readonly NativeAgent[], Rollup>()

/** The one count of an Apex's Fins every surface shows: the same object while the Fins are. */
export function rollup(children: readonly NativeAgent[]): Rollup {
  if (!children.length) return EMPTY_ROLLUP
  const held = rollups.get(children)
  if (held) return held
  const counts = { ...EMPTY_ROLLUP, total: children.length }
  for (const child of children) counts[childGroup(childStateOf(child))] += 1
  rollups.set(children, counts)
  return counts
}

export function sameRollup(left: Rollup, right: Rollup): boolean {
  return left.total === right.total && left.needs === right.needs && left.working === right.working &&
    left.queued === right.queued && left.idle === right.idle && left.failed === right.failed && left.done === right.done
}

/** Each group's words after its count, in the one vocabulary every surface uses. */
export function groupWords(group: ChildGroup, count: number): string {
  switch (group) {
    case "needs":
      return count === 1 ? "needs you" : "need you"
    default:
      return group
  }
}

/** The groups that hold Fins, in `CHILD_GROUPS`' order: "2 need you · 5 working · 1 idle". */
export function rollupLine(counts: Rollup): string {
  return CHILD_GROUPS.filter((group) => counts[group] > 0).map((group) => `${counts[group]} ${groupWords(group, counts[group])}`).join(" · ")
}

/**
 * The short form, where a chip has the room for a few words: how many Fins, then what needs the person and what's
 * working, or with neither the first group there is. "4 Fins · 3 working"; every number in it is one `rollupLine`
 * says, so no two surfaces can disagree.
 */
export function rollupChip(counts: Rollup): string {
  const live = (["needs", "working"] as const).filter((group) => counts[group] > 0)
  const shown = live.length ? live : CHILD_GROUPS.filter((group) => counts[group] > 0).slice(0, 1)
  return [finsWord(counts.total), ...shown.map((group) => `${counts[group]} ${groupWords(group, counts[group])}`)].join(" · ")
}

/** The badge's words, for screen readers and tips: "12 Fins: 2 need you · 5 working · 2 queued · 3 done". */
export function rollupLabel(counts: Rollup): string {
  return counts.total ? `${finsWord(counts.total)}: ${rollupLine(counts)}` : finsWord(0)
}

const STEP_CHARS = 60
const HOME = /\/(?:Users|home)\/[^/\s]+/g
/** A tool's label (`identifyTool`'s) and the verb its step reads with. */
const VERB = new Map([
  ["Shell", "Running"], ["Script", "Running"], ["Read", "Reading"], ["Lints", "Reading lints in"], ["Edit", "Editing"],
  ["Write", "Writing"], ["Delete", "Deleting"], ["Move", "Moving"], ["List", "Listing"], ["Search", "Searching"], ["Find", "Finding"],
])
const WRAPPERS = new Set(["npx", "sudo", "time", "env", "nohup", "exec", "command"])

/** A path as a person reads it in a line: its file or folder name. */
function shortPath(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "")
  return trimmed.split(/[/\\]/).filter(Boolean).at(-1) ?? trimmed
}

/** What a command line does, in its first few words: "gh pr checks 340", "npm run typecheck"; "" when only setup. */
function commandGist(command: string): string {
  const quoted = /^(?:z|ba)?sh\s+-l?c\s+(['"])(.*)\1\s*$/.exec(command.trim())
  if (quoted) return commandGist(quoted[2]!)
  const segment = command.split(/\s*(?:&&|\|\||;|\|)\s*/).map((part) => part.trim())
    .find((part) => part && !/^(?:cd|export|source|set|true|:|echo)\b/.test(part) && !/^\w+=\S*$/.test(part))
  if (!segment) return ""
  const tokens = segment.split(/\s+/)
  while (tokens.length && (WRAPPERS.has(tokens[0]!) || /^\w+=/.test(tokens[0]!))) tokens.shift()
  if (tokens[0] === "timeout") tokens.splice(0, 2)
  const kept: string[] = []
  for (const token of tokens) {
    if (kept.length === 4 || /^-|[<>|$'"`(){}]|\d>&/.test(token)) break
    kept.push(/[/\\]/.test(token) ? shortPath(token) : token)
  }
  return kept.join(" ")
}

/**
 * A Fin's step as a phrase, not the raw tool call: "Running gh pr checks 340" for
 * "Shell cd /Users/you/… && gh pr checks 340 -R … 2>&1 | awk …", "Editing dock.tsx" for an edit's full path. A step
 * that names no tool keeps its words, with home folders shortened. Also reads steps hosts recorded before this.
 */
export function readableStep(step: string | undefined): string | undefined {
  if (!step) return step
  const label = [...VERB.keys()].find((verb) => step === verb || step.startsWith(`${verb} `))
  const rest = label ? step.slice(label.length).trim().replace(/…$/, "") : ""
  const phrase = !label
    ? step.replace(HOME, "~")
    : label === "Shell" || label === "Script"
      ? (() => { const gist = commandGist(rest); return gist ? `Running ${gist}` : "Running a command" })()
      : label === "Search" || label === "Find"
        ? `${VERB.get(label)} ${rest.replace(HOME, "~")}`.trim()
        : `${VERB.get(label)} ${shortPath(rest)}`.trim()
  return phrase.length > STEP_CHARS ? `${phrase.slice(0, STEP_CHARS - 1).trimEnd()}…` : phrase
}

/**
 * What a child's state says in a line: its question, its phase or step, why it waits, or how it ended. With `now`, a
 * Fin waiting on what its report named says for how long: "Waiting on acme/app#371 checks · 12m".
 */
export function childLine(state: ChildState, now?: number): string | undefined {
  switch (state.kind) {
    case "queued":
      if (state.refused) return "Not started: it couldn't start"
      if (state.held) return `Not started: ${state.held} didn't finish`
      if (state.after?.length) return `Starts after ${state.after.join(", ")}`
      return state.ahead ? `Queued: ${state.ahead} ahead` : "Queued: next to start"
    case "starting":
      return "Starting"
    case "working":
      return state.phase ?? (state.answered && answeredWords(state.answered)) ?? readableStep(state.step) ?? "At work"
    case "blocked":
      return state.question
    case "idle":
      return state.waitingOn?.length ? waitingStateWords(state.waitingOn, state.since, now) : "Idle: a message gives it its next turn"
    case "ended":
      return state.decision?.question ?? state.reason
  }
}

/** How long a Fin has stood as it does, one unit: "25s", "18m", "1h 4m", "3 d". Nothing under a second. */
export function stoodFor(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 1) return ""
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)} d`
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

/** A row's time, and the sentence that says what it means. */
export interface TimeWords {
  time: string
  title: string
}

/**
 * A row's time and what it means. It's how long the Fin has stood as it does (`childSince`), which on an ended row
 * would read as how long it ran, so that one says "ago"; the sentence says it whole in every state.
 */
export function timeWords(state: ChildState, stood: string): TimeWords {
  if (!stood) return { time: "", title: "" }
  switch (state.kind) {
    case "queued":
      return { time: stood, title: `Queued for ${stood}` }
    case "starting":
      return { time: stood, title: `Starting for ${stood}` }
    case "working":
      return { time: stood, title: state.step?.startsWith("Waiting for ") ? `Waiting for ${stood}` : `On this turn for ${stood}` }
    case "blocked":
      return { time: stood, title: `Asked ${stood} ago` }
    case "idle":
      return { time: stood, title: `${state.waitingOn?.length ? "Waiting" : "Idle"} for ${stood}` }
    case "ended":
      return { time: `${stood} ago`, title: `${{ done: "Finished", failed: "Failed", stopped: "Stopped" }[state.outcome]} ${stood} ago` }
  }
}

/** `timeWords` for a time in milliseconds. */
export function childTime(state: ChildState, ms: number): TimeWords {
  return timeWords(state, stoodFor(ms))
}

/** A child's state in one word, as its strip and its tip say it. */
export function childWord(state: ChildState): string {
  switch (state.kind) {
    case "queued":
      return "Queued"
    case "starting":
      return "Starting"
    case "working":
      return "Working"
    case "blocked":
      return state.on === "lead" ? `Asks its ${APEX_WORD}` : state.on === "approval" ? "Needs approval" : "Needs your answer"
    case "idle":
      return state.waitingOn?.length ? "Waiting" : "Idle"
    case "ended":
      return state.outcome === "done" ? (state.decision?.on === "person" ? DONE_NEEDS_YOU : "Done") : state.outcome === "failed" ? "Failed" : "Stopped"
  }
}
