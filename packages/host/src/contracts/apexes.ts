import { z } from "zod"
import { APEX_WORD, FIN_WORD } from "./agents.js"
import { askWords, childGroup, childLine, childStateOf, openAsk } from "./children.js"
import type { NativeAgent } from "./native-agents.js"

/**
 * A deliberate Apex (AGENTS.md, "Deliberate Apexes"): a top-level Thread the person, or an agent for them, made an Apex on purpose,
 * with a name, a one-line purpose, its own rules, its Fins' rules and a plan. No kinds or types: what it's for is the
 * person's first message, which the Apex writes into its rules and plan. An Apex that came about by starting a Fin is
 * still an Apex (`Agents.isApex`); a deliberate one has this profile beside it, in the Thread store (`apexes`), and
 * its files in its folder of the person's data (`apexFolder`).
 */

export const APEX_NAME_CHARS = 60
/** "Whose Apex this is and what it covers", on its row, the addressee picker and the routing suggestion. */
export const APEX_PURPOSE_CHARS = 140

/** Where an Apex's Fins run unless a start names a place: `here` (this device) or `device:<name>`. */
export const FinsRunSchema = z.string().regex(/^(?:here|device:.{1,120})$/)
export type FinsRun = z.infer<typeof FinsRunSchema>

export const ApexProfileSchema = z.object({
  thread: z.string().uuid(),
  name: z.string().trim().min(1).max(APEX_NAME_CHARS),
  purpose: z.string().trim().max(APEX_PURPOSE_CHARS).optional(),
  /** What its Fins start on when a start names nothing: its harness, model, and where they run. */
  fins: z.object({ harness: z.string().min(1).max(64).optional(), model: z.string().min(1).max(200).optional(), run: FinsRunSchema.optional() }).optional(),
  createdAt: z.number(),
  /** Made new, or an existing Thread made an Apex (it keeps its history, branch and Fins). */
  from: z.enum(["new", "thread"]),
  /** The person, or the agent of the Thread that made it for them. */
  by: z.enum(["person", "agent"]),
  /** When the person last read its digest: what's new is what came after (`apexDigest`). */
  seenAt: z.number().optional(),
  /** The Needs you the Apex last saw at a turn's start, by item key: its next turn's note says whether it changed. */
  needsSaid: z.array(z.string().max(300)).max(64).optional(),
})
export type ApexProfile = z.infer<typeof ApexProfileSchema>

/** What a start that makes an Apex says of it (`LiveStartOptions.apex`): its profile less the Thread the start makes. */
export const ApexStartSchema = ApexProfileSchema.omit({ thread: true, createdAt: true, seenAt: true, needsSaid: true })
export type ApexStart = z.input<typeof ApexStartSchema>

// ── Rules, in layers ──

/**
 * The layers of standing rules, most general first. Each is said whole once to a process and again only when it
 * changes, as Mako's standing lines are (`standingLines`), so nothing is repeated turn to turn; the person's rules for
 * every Apex and every Fin (Settings › Fins, `roleRuleLines`) stay their own lines between them. Repo rule files
 * (AGENTS.md, CLAUDE.md) load as each harness loads them, outside these.
 */
export const RULE_LAYERS = ["you", "you-folder", "folder", "apex", "apex-fins"] as const
export type RuleLayer = (typeof RULE_LAYERS)[number]
/** Who writes each: the person in the Overview or Settings, and an Apex its own two through `apex rules_write`. */
export const RULE_LAYER_CHARS = 8_000
/** What every layer together adds to one agent's note: past it, the most general are cut, then left out. */
export const RULES_BUDGET_CHARS = 20_000
/** A layer cut to fit keeps at least this much, else it's left out. */
const CUT_FLOOR = 400

/** The standing line each layer is said as. */
export const RULE_LAYER_LINES = {
  you: "rules:you",
  "you-folder": "rules:you-folder",
  folder: "rules:folder",
  apex: "rules:apex",
  "apex-fins": "rules:apex-fins",
} as const satisfies Record<RuleLayer, string>

/** The person's own scopes, which `memory_save` also saves lessons to. */
export const MEMORY_SCOPES = ["you", "you-folder", "folder"] as const
export type MemoryScope = (typeof MEMORY_SCOPES)[number]
export const MEMORY_TOPIC_CHARS = 80
export const MEMORY_LESSON_CHARS = 600
/** Lessons kept in one scope (one folder's, for a folder's); a save past it drops the one confirmed longest ago. */
export const MEMORY_KEPT = 60

export const MemorySchema = z.lazy(() => z.object({
  id: z.string().min(1).max(80),
  scope: z.enum(MEMORY_SCOPES),
  /** The project folder, for `you-folder` and `folder`. */
  folder: z.string().min(1).max(4096).optional(),
  topic: z.string().trim().min(1).max(MEMORY_TOPIC_CHARS),
  lesson: z.string().trim().min(1).max(MEMORY_LESSON_CHARS),
  savedAt: z.number(),
  /** When it was last said or saved again: a lesson nobody confirms for long is the first to go. */
  confirmedAt: z.number(),
  /** The Thread whose agent saved it, when an agent did. */
  by: z.string().uuid().optional(),
}))
export type Memory = z.infer<typeof MemorySchema>

/** One layer as an agent's note carries it: its words, its lessons, and what was cut to fit. */
export interface RulePart {
  layer: RuleLayer
  /** "You", "You in mako", "mako", "Mobile", "Mobile's Fins". */
  label: string
  /** Who reads it, in the Overview's words: "Every Thread you start, everywhere". */
  audience: string
  text: string
  memories: number
  /** Characters it holds before any cut. */
  chars: number
  /** What it adds to the note now. */
  sent: number
  fit?: "cut" | "left-out"
}

/** An Apex's own two layers, as its files hold them; an empty one is absent. */
export interface ApexOwnRules {
  rules?: string
  finRules?: string
}

/** The person's own layers for a folder and the lessons it reads, as Settings and the Overview edit them. */
export interface PersonLayers {
  you: string
  youFolder: string
  folder: string
  memories: Memory[]
}

/** What one reader takes of each layer: an Apex its own rules, a Fin its Apex's Fin rules, and everyone the person's. */
export interface RuleReading {
  you?: string
  youFolder?: string
  folder?: string
  folderName?: string
  memories: readonly Memory[]
  apex?: { name: string; rules?: string; finRules?: string }
  as: "apex" | "fin" | "thread"
}

const AUDIENCE = (layer: RuleLayer, folder: string, apex: string): string => ({
  you: "Every Thread you start, everywhere",
  "you-folder": `Every Thread you start in ${folder}`,
  folder: `Every Thread in ${folder}, whoever starts it`,
  apex: `What ${apex} itself follows`,
  "apex-fins": `Every ${FIN_WORD} of ${apex} follows these; ${apex} doesn't`,
})[layer]

const LABEL = (layer: RuleLayer, folder: string, apex: string): string => ({
  you: "You",
  "you-folder": `You in ${folder}`,
  folder,
  apex,
  "apex-fins": `${apex}'s ${FIN_WORD}s`,
})[layer]

function memoryLines(memories: readonly Memory[], scope: MemoryScope): string[] {
  return memories
    .filter((memory) => memory.scope === scope)
    .sort((a, b) => b.confirmedAt - a.confirmedAt)
    .map((memory) => `- ${memory.topic}: ${memory.lesson} (confirmed ${new Date(memory.confirmedAt).toISOString().slice(0, 10)})`)
}

/**
 * The layers a reader takes, each with its size and, past `RULES_BUDGET_CHARS`, what was cut to fit: the most
 * specific keep their room, so an Apex's own rules outlast the person's general ones. What the Overview's context
 * preview shows and the note carries are the same parts.
 */
export function ruleParts(reading: RuleReading, budget = RULES_BUDGET_CHARS): RulePart[] {
  const folder = reading.folderName ?? "this folder"
  const apex = reading.apex?.name ?? APEX_WORD
  const wanted: { layer: RuleLayer; text: string; memories: number }[] = []
  const add = (layer: RuleLayer, rules: string | undefined, scope?: MemoryScope) => {
    const lessons = scope ? memoryLines(reading.memories, scope) : []
    const text = [rules?.trim(), lessons.length ? `Remembered:\n${lessons.join("\n")}` : undefined].filter(Boolean).join("\n\n")
    wanted.push({ layer, text, memories: lessons.length })
  }
  add("you", reading.you, "you")
  add("you-folder", reading.youFolder, "you-folder")
  add("folder", reading.folder, "folder")
  if (reading.as === "apex" && reading.apex) add("apex", reading.apex.rules)
  if (reading.as === "fin" && reading.apex) add("apex-fins", reading.apex.finRules)
  let left = budget
  const parts = new Map<RuleLayer, RulePart>()
  // The most specific first: what's left after it goes to the next more general one.
  for (const { layer, text, memories } of [...wanted].reverse()) {
    const part: RulePart = { layer, label: LABEL(layer, folder, apex), audience: AUDIENCE(layer, folder, apex), text, memories, chars: text.length, sent: text.length }
    if (text.length > left) {
      if (left >= CUT_FLOOR) Object.assign(part, { text: `${text.slice(0, left - 1).trimEnd()}…`, sent: left, fit: "cut" as const })
      else Object.assign(part, { text: "", sent: 0, fit: "left-out" as const })
    }
    left -= part.sent
    parts.set(layer, part)
  }
  return wanted.map(({ layer }) => parts.get(layer)!)
}

/** Each layer's standing line by its name (`RULE_LAYER_LINES`), where it has something to say. */
export interface RuleLayerLines {
  "rules:you"?: string
  "rules:you-folder"?: string
  "rules:folder"?: string
  "rules:apex"?: string
  "rules:apex-fins"?: string
}

/** Every standing line a deliberate Apex's reader takes beside the person's: the layers, and what each is to the other. */
export interface ApexStandingLines extends RuleLayerLines {
  "apex-role"?: string
  "apex-fin-role"?: string
}

/** The standing line of one layer, or the line saying it went quiet, once its reader read it (`read`). */
export function ruleLayerLines(parts: readonly RulePart[], read: ReadonlySet<string>): RuleLayerLines {
  const lines: RuleLayerLines = {}
  for (const part of parts) {
    const name = RULE_LAYER_LINES[part.layer]
    if (part.text) lines[name] = `Rules · ${part.label} (${part.audience.charAt(0).toLowerCase()}${part.audience.slice(1)}):${part.fit === "cut" ? " [cut to fit]" : ""}\n${part.text}`
    else if (read.has(name)) lines[name] = `Rules · ${part.label}: none now; any it gave you before no longer apply.`
  }
  return lines
}

// ── The plan ──

/** An Apex's plan's sections, in this order: what each item waits on is the section it's in. */
export const PLAN_SECTIONS = ["Now", "Waiting on you", "Blocked", "Decided", "Files", "Revisit"] as const
export type PlanSection = (typeof PLAN_SECTIONS)[number]
/** The plan's file, `PLAN.md` in the Apex's folder, at most this long. */
export const PLAN_CHARS = 24_000
/** What of it the Apex reads at the start of each turn; the rest it reads with `apex plan`. */
export const PLAN_TURN_CHARS = 6_000
export const PLAN_FILE = "PLAN.md"
export const PLAN_LINE = "apex-plan"

export interface PlanItem {
  done: boolean
  text: string
  /** A plain bullet, no checkbox: a note (a file, a decision) rather than something to do. */
  note?: true
  /** The Fin it's about, when its text names one as `fin:<name>`. */
  fin?: string
}
export interface Plan {
  title?: string
  intro?: string
  sections: { name: string; items: PlanItem[]; text?: string }[]
}

const ITEM = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/
const BULLET = /^\s*[-*]\s+(.*)$/

/** A plan file read into its sections and items; anything it doesn't know stays as its section's text. */
export function parsePlan(markdown: string): Plan {
  const plan: Plan = { sections: [] }
  let section: Plan["sections"][number] | undefined
  const intro: string[] = []
  for (const line of markdown.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      section = { name: heading[1]!, items: [] }
      plan.sections.push(section)
      continue
    }
    const title = /^#\s+(.+?)\s*$/.exec(line)
    if (title && !section && plan.title === undefined) {
      plan.title = title[1]!
      continue
    }
    if (!section) {
      if (line.trim()) intro.push(line)
      continue
    }
    const checked = ITEM.exec(line)
    const bullet = checked ? null : BULLET.exec(line)
    if (checked || bullet) {
      const text = (checked ? checked[2] : bullet![1])!.trim()
      const fin = /\bfin:([\w.-]+)/.exec(text)?.[1]
      section.items.push({ done: checked ? checked[1]!.toLowerCase() === "x" : false, text, ...(bullet && { note: true as const }), ...(fin && { fin }) })
    } else if (line.trim()) section.text = section.text ? `${section.text}\n${line}` : line
  }
  if (intro.length) plan.intro = intro.join("\n")
  return plan
}

/** A plan written back, the six sections first and in order, each even when empty. */
export function planText(plan: Plan): string {
  const known = PLAN_SECTIONS.map((name) => plan.sections.find((section) => section.name === name) ?? { name, items: [] })
  const named: ReadonlySet<string> = new Set(PLAN_SECTIONS)
  const others = plan.sections.filter((section) => !named.has(section.name))
  const out: string[] = []
  if (plan.title) out.push(`# ${plan.title}`, "")
  if (plan.intro) out.push(plan.intro, "")
  for (const section of [...known, ...others]) {
    out.push(`## ${section.name}`, "")
    for (const item of section.items) out.push(item.note && !item.done ? `- ${item.text}` : `- [${item.done ? "x" : " "}] ${item.text}`)
    if (section.text) out.push(section.text)
    if (section.items.length || section.text) out.push("")
  }
  return `${out.join("\n").trimEnd()}\n`
}

/** A new Apex's plan: its name, its purpose when it has one, and the six sections waiting for it to fill. */
export function seedPlan(name: string, purpose?: string): string {
  return planText({ title: name, ...(purpose && { intro: purpose }), sections: [] })
}

/** An item checked or unchecked, by its section and its place there: the Overview's checkbox. */
export function checkPlanItem(markdown: string, section: string, index: number, done: boolean): string | undefined {
  const plan = parsePlan(markdown)
  const item = plan.sections.find((each) => each.name === section)?.items[index]
  if (!item) return undefined
  item.done = done
  delete item.note
  return planText(plan)
}

/** What the Apex reads of its plan at a turn's start: whole, or its head and where the rest is. */
export function planNote(name: string, markdown: string | undefined): string | undefined {
  const text = markdown?.trim()
  if (!text) return undefined
  const head = `Your plan, ${name}'s ${PLAN_FILE} (yours to keep true with apex plan_write or plan_edit; the person reads and checks it in your Overview):`
  if (text.length <= PLAN_TURN_CHARS) return `${head}\n${text}`
  return `${head}\n${text.slice(0, PLAN_TURN_CHARS)}…\n[${text.length - PLAN_TURN_CHARS} more characters: apex plan]`
}

// ── The digest ──

export const DIGEST_SECTIONS = ["needs", "new", "progress"] as const
export type DigestSection = (typeof DIGEST_SECTIONS)[number]
export const DIGEST_HEADINGS = { needs: "Needs you", new: "New", progress: "In progress" } as const satisfies Record<DigestSection, string>

export interface DigestItem {
  /** Stable while the fact stands: the Fin and its ask, its report, or the plan's line. */
  key: string
  /** The Fin it's about, by its Thread, name and title; absent for a line of the Apex's own plan. */
  fin?: { thread: string; name?: string; title: string }
  line: string
  kind: "ask" | "approval" | "decision" | "plan" | "done" | "failed" | "working" | "queued" | "waiting"
  /** When it came to stand so, where that's known. */
  at?: number
}
export interface ApexDigest {
  needs: DigestItem[]
  new: DigestItem[]
  progress: DigestItem[]
}

/** A plan line that waits on the person: unchecked, under "Waiting on you" (or "Waiting on <their name>"). */
function waitsOnPerson(section: string): boolean {
  return /^waiting on\b/i.test(section)
}

/**
 * An Apex's digest, from what Mako already holds of its Fins (their asks, decisions, reports, failures, work) and the
 * lines its plan says wait on the person. Nothing in it is written by hand, so it can't drift from how things stand:
 * an ask answered, a Fin stopped or a plan line checked leaves it at once. New is what finished since the person last
 * read it (`seenAt`).
 */
export function apexDigest(fins: readonly NativeAgent[], plan: string | undefined, seenAt: number | undefined): ApexDigest {
  const digest: ApexDigest = { needs: [], new: [], progress: [] }
  for (const agent of fins) {
    if (!agent.child) continue
    const state = childStateOf(agent)
    const group = childGroup(state)
    const fin = { thread: agent.child.thread, ...(agent.child.name && { name: agent.child.name }), title: agent.title ?? agent.child.name ?? FIN_WORD }
    const at = agent.since ?? agent.settledAt ?? agent.observedAt
    const ask = openAsk(state)
    if (group === "needs" && ask) {
      const kind = ask.on === "approval" ? "approval" : ask.done ? "decision" : "ask"
      digest.needs.push({ key: `ask:${fin.thread}:${ask.ask?.id ?? ask.question}`, fin, line: askWords(ask), kind, at })
      continue
    }
    if (group === "failed" || group === "done") {
      if (seenAt !== undefined && at <= seenAt) continue
      const line = childLine(state) ?? (group === "failed" ? "Failed" : "Done")
      digest.new.push({ key: `${group}:${fin.thread}:${at}`, fin, line, kind: group, at })
      continue
    }
    if (group === "working" || group === "queued" || (group === "idle" && state.kind === "idle" && state.waitingOn?.length)) {
      const kind = group === "working" ? "working" : group === "queued" ? "queued" : "waiting"
      digest.progress.push({ key: `${kind}:${fin.thread}`, fin, line: childLine(state) ?? "At work", kind, at })
    }
  }
  if (plan) {
    for (const section of parsePlan(plan).sections) {
      if (!waitsOnPerson(section.name)) continue
      for (const item of section.items) if (!item.done) digest.needs.push({ key: `plan:${section.name}:${item.text}`, line: item.text, kind: "plan" })
    }
  }
  digest.new.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  return digest
}

/** Whether what needs the person is the same set as before: an Apex speaks to them only when it isn't. */
export function needsChanged(before: readonly string[] | undefined, digest: Pick<ApexDigest, "needs">): boolean {
  const now = new Set(digest.needs.map((item) => item.key))
  const was = new Set(before ?? [])
  return now.size !== was.size || [...now].some((key) => !was.has(key))
}

export const DIGEST_LINE = "apex-digest"

/**
 * What the Apex hears at a turn's start of its digest: what needs the person now, and whether that changed since its
 * last turn, which is when it says something to them. Otherwise it ends its turn quietly and batches.
 */
export function digestNote(digest: ApexDigest, changed: boolean): string {
  const needs = digest.needs.slice(0, 8).map((item) => `- ${item.fin ? `fin:${item.fin.name ?? item.fin.title}: ` : ""}${item.line}`)
  const more = digest.needs.length > needs.length ? [`- … and ${digest.needs.length - needs.length} more`] : []
  const head = digest.needs.length
    ? `Needs the person now (${changed ? "changed since your last turn" : "unchanged since your last turn"}):`
    : `Nothing needs the person now${changed ? " (that changed since your last turn)" : ""}.`
  const rule = changed
    ? "Tell the person, in a few lines: what needs them, each with what you recommend. Lead with the decision."
    : "Don't message the person about it again: handle what's yours, update your plan, and end your turn with one line, or none."
  return [head, ...needs, ...more, rule].join("\n")
}

/** What heads Mako's note to a deliberate Apex (`Apexes.tellApex`): its words, never the person's. */
export const APEX_NOTE_PREFIX = "[mako · not the person] "

/**
 * Mako's note to an Apex as the person reads it in its transcript: who joined, in a line. "fin:readme (“README
 * overview”) joined your Shiver. …" reads "README overview joined the Shiver".
 */
export function apexNoteLine(text: string): string {
  const body = text.startsWith(APEX_NOTE_PREFIX) ? text.slice(APEX_NOTE_PREFIX.length) : text
  const first = body.split(/(?<=\.)\s/, 1)[0] ?? body
  return first.replace(/fin:[\w.-]+ \(“([^”]+)”\)/g, "$1").replace(/joined your Shiver\.?$/, `joined the ${"Shiver"}`).replace(/\.$/, "")
}

// ── Gathering Threads ──

/** Why a Thread can't move into an Apex, each said in Mako's words (`gatherWords`). */
export type GatherRefusal =
  | "self"
  | "not-found"
  | "not-top-level"
  | "is-apex"
  | "archived"
  | "other-folder"
  | "in-another-apex"
  | "other-device"
  | "not-open"
  | "access-wider"
  | "unavailable"

export interface GatherRefused {
  thread: string
  title?: string
  refused: GatherRefusal
  why: string
  /** A refusal the person can confirm past: moving it in lowers its access to the Apex's. */
  confirmable?: true
}

export interface GatherFacts {
  title: string
  apex: string
  folder?: string
  apexFolder?: string
  other?: string
  access?: string
  apexAccess?: string
  device?: string
}

export function gatherWords(refused: GatherRefusal, facts: GatherFacts): string {
  const { title, apex } = facts
  switch (refused) {
    case "self":
      return `${apex} can't be one of its own ${FIN_WORD}s.`
    case "not-found":
      return `No Thread called “${title}” is on this device.`
    case "not-top-level":
      return `“${title}” is a ${FIN_WORD} of a ${FIN_WORD}. It moves with the Thread above it.`
    case "is-apex":
      return `“${title}” is an ${APEX_WORD} itself. An ${APEX_WORD} doesn't work for another: message it instead.`
    case "archived":
      return `“${title}” is archived. Restore it first, then move it in.`
    case "other-folder":
      return `“${title}” works in ${facts.folder ?? "another folder"}, and ${apex}'s ${FIN_WORD}s stay in ${facts.apexFolder ?? "its own"}.`
    case "in-another-apex":
      return `“${title}” already works for ${facts.other ?? `another ${APEX_WORD}`}. A Thread works for one ${APEX_WORD}: hand it over from there.`
    case "other-device":
      return `“${title}” runs on ${facts.device ?? "another device"}. Move it here first.`
    case "not-open":
      return `“${title}” hasn't run in Mako on this device. Send it a message here first, then move it in.`
    case "access-wider":
      return `“${title}” runs on ${facts.access ?? "wider access"}, more than ${apex}'s ${facts.apexAccess ?? "access"}. Moving it in lowers it to ${facts.apexAccess ?? "that"}.`
    case "unavailable":
      return `Mako couldn't move “${title}” in right now. Try again in a moment.`
  }
}

// ── Routing a message with no clear owner ──

export interface RouteCandidate {
  thread: string
  name: string
  purpose?: string
  folder?: string
}

const STOP = new Set("a an and are as at be but by for from has have i in is it its me my of on or our so that the their them this to us we what when where which who will with you your".split(" "))

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STOP.has(word)).map((word) => word.replace(/(ing|ed|es|s)$/, "")))
}

/**
 * The Apex a message with no clear owner most likely is for: those in its folder first, then by how many words of the
 * message their name and purpose share (a name counts double). `one` when one fits clearly, `two` when two fit about
 * as well (ask which), or nothing.
 */
export function routeFor(text: string, folder: string | undefined, apexes: readonly RouteCandidate[]): { kind: "one"; apex: RouteCandidate } | { kind: "two"; apexes: [RouteCandidate, RouteCandidate] } | undefined {
  const said = words(text)
  if (!said.size) return undefined
  const scored = apexes
    .filter((apex) => !folder || !apex.folder || apex.folder === folder)
    .map((apex) => {
      const named = words(apex.name)
      const purpose = words(apex.purpose ?? "")
      let score = 0
      for (const word of said) score += named.has(word) ? 2 : purpose.has(word) ? 1 : 0
      return { apex, score }
    })
    .filter((each) => each.score > 0)
    .sort((a, b) => b.score - a.score)
  const [first, second] = scored
  if (!first) return undefined
  if (second && second.score * 1.5 >= first.score) return { kind: "two", apexes: [first.apex, second.apex] }
  return { kind: "one", apex: first.apex }
}

// ── What the host answers ──

/** An Apex as every window and the phone list it: its profile, where it works, and the conversation that speaks for it. */
export interface ApexEntry extends ApexProfile {
  handle: string
  conversation?: string
  folder?: string
  harness?: string
}

export interface ApexRefused {
  refused: "unavailable" | "no-thread" | "not-yours" | "not-top-level" | "is-apex" | "not-apex" | "invalid" | "unknown-apex" | "failed"
  why: string
}

/** A new Apex, from the New Apex form, the palette or an agent's `apex create`. */
export interface ApexCreateInput {
  name: string
  purpose?: string
  /** The folder its Thread works in, and so its Fins. */
  cwd: string
  harness: string
  model?: string
  reasoning?: string
  fins?: { harness?: string; model?: string; run?: string }
  /** Its first message: what it's for and what to start on. Absent, it greets the person and asks. */
  message?: string
  /** At most the caller's; absent, the harness's default (the person) or the caller's (an agent). */
  modeId?: string
  /** A repeat with the same key is the same Apex. */
  clientKey: string
}
export type ApexCreateResult = { thread: string; conversation: string; name: string; deduped?: true } | ApexRefused

export interface ApexChange {
  name?: string
  /** Null clears it. */
  purpose?: string | null
  fins?: { harness?: string; model?: string; run?: string } | null
}

export type ApexProfileResult = { apex: ApexEntry } | ApexRefused

/** Threads moved into an Apex, and those that stayed out, each with why. */
export interface ApexGathered {
  moved: { thread: string; title: string; name: string }[]
  stayed: GatherRefused[]
}
export type ApexGatherResult = ApexGathered | ApexRefused

/** What one reader of an Apex takes of every layer, as its context preview shows it. */
export interface ApexRulesReading {
  as: "apex" | "fin"
  parts: RulePart[]
  budget: number
  /** Each layer's own words, as the person edits them. */
  texts: Partial<Record<RuleLayer, string>>
  folder?: string
  folderName?: string
  memories: Memory[]
  /** The person's rules for every Apex or every Fin (Settings › Fins), which this reader takes as their own line. */
  role?: string
}

export interface ApexPlanReading {
  text: string
  chars: number
  /** Where the file is, for an agent that reads it whole. */
  path?: string
}

// ── The tools an agent calls ──

export type ApexAction = "create" | "promote" | "demote" | "update" | "list" | "get" | "plan" | "plan_write" | "plan_edit" | "plan_check" | "rules" | "rules_write" | "gather" | "hand"

export interface ApexActInput {
  action: ApexAction
  /** create, promote, update: its name. */
  name?: string
  /** create, promote, update: whose Apex this is and what it covers, in a line. */
  purpose?: string
  /** create: the folder it works in; absent, this Thread's. */
  folder?: string
  /** create: its harness and model; absent, this Thread's. */
  harness?: string
  model?: string
  /** create: its first message, in the person's words where they gave them. */
  message?: string
  /** create, update: where its Fins run: here or device:<name>. */
  finsRun?: string
  /** gather: the Threads to move into this Apex, by handle, title or Thread ID. hand: the one Fin to hand over. */
  threads?: string[]
  /** hand: the Apex that takes it, by name, handle or Thread ID. get: which Apex; absent, this one. */
  to?: string
  /** gather, hand: the person agreed to the access change the last answer named. */
  confirm?: boolean
  /** plan_write: the whole plan; rules_write: the whole layer. */
  text?: string
  /** plan_edit: the exact text to replace, and what replaces it. */
  old?: string
  new?: string
  /** plan_check: the section, the item's place in it from 0, and whether it's done (default true). */
  section?: string
  item?: number
  done?: boolean
  /** rules_write: apex (yours) or fins (every Fin's). */
  layer?: "apex" | "fins"
  /** The person's own call only: the conversation whose Thread it is. An agent acts on its own. */
  conversation?: string
  clientKey: string
}

export type ApexActResult =
  | { outcome: "created"; apex: { thread: string; name: string; conversation: string }; next: string }
  | { outcome: "promoted" | "updated"; apex: ApexEntry; next: string }
  | { outcome: "demoted"; released: string[]; next: string }
  | { outcome: "listed"; apexes: { handle: string; name: string; purpose?: string; folder?: string; fins: number; you?: true }[] }
  | { outcome: "got"; apex: ApexEntry; digest: ApexDigest; plan?: string }
  | { outcome: "gathered"; moved: ApexGathered["moved"]; stayed: GatherRefused[]; next: string }
  | { outcome: "handed"; thread: string; to: string; next: string }
  | Exclude<ApexPlanResult, ApexRefused>
  | Exclude<ApexRulesResult, ApexRefused>
  | ApexRefused

export interface ApexPlanInput {
  /** read (default), write (the whole file), edit (replace old with new), check (an item, by section and place). */
  action?: "read" | "write" | "edit" | "check"
  text?: string
  old?: string
  new?: string
  section?: string
  item?: number
  done?: boolean
  conversation?: string
  clientKey: string
}
export type ApexPlanResult =
  | { outcome: "read"; plan: string; chars: number }
  | { outcome: "written"; chars: number; next: string }
  | { outcome: "edited"; replacements: number; chars: number }
  | ApexRefused

export interface ApexRulesInput {
  /** read (default): every layer as you and your Fins read them; write: your own or your Fins'. */
  action?: "read" | "write"
  /** write: apex, your own; fins, every Fin of yours reads them. */
  layer?: "apex" | "fins"
  text?: string
  conversation?: string
  clientKey: string
}
export type ApexRulesResult =
  | { outcome: "read"; apex: RulePart[]; fins: RulePart[] }
  | { outcome: "written"; layer: "apex" | "fins"; chars: number; next: string }
  | ApexRefused

export interface MemorySaveInput {
  /** you (everywhere), you-folder (you, in this folder) or folder (every Thread in this folder). */
  scope: MemoryScope
  /** A few words it's filed under: a second save of the same topic replaces it and marks it confirmed today. */
  topic: string
  /** The lesson, in a sentence or two, as the person would want it kept. */
  lesson: string
  conversation?: string
  clientKey: string
}
export type MemorySaveResult = { outcome: "saved"; id: string; replaced?: true; scope: MemoryScope; next: string } | ApexRefused

/** What each answer tells an agent to do next. */
export const AFTER_APEX = {
  created: "It's started on its first message and runs on its own: tell the person its name and that it's in their rail. Don't message it unless they ask.",
  promoted: `This Thread is an ${APEX_WORD} now. Write what it's for into your rules (apex rules_write) and your plan (apex plan_write) before anything else.`,
  updated: "Saved.",
  demoted: "This Thread is a Thread again: its history, branch and Fins it started stay; Threads moved in went back to being their own.",
  gathered: `Read each with agents_read and fold it into your plan under Now.`,
  handed: `It's the other ${APEX_WORD}'s now: take it out of your plan.`,
  planWritten: "Saved: you read it at the start of every turn.",
  rulesWritten: "Saved: it's in your note from your next message on.",
  memorySaved: "Saved: every Thread in its scope reads it from its next message on.",
} as const
