import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { JsonValue } from "../electron/codex-app-json.ts"
import { eventText } from "@mako/sessions/events"
import type { AttachmentContent } from "@mako/sessions/content"
import type { ToolCall } from "@/extend/slots"
import type { Block, ChatMessage } from "@/lib/types"
import { acpBlocksToMessages } from "@/lib/acp-blocks"
import { threadToMessages } from "@/lib/foreign-thread"
import { foldTools, pairTools } from "@/lib/tools"
import { createLiveEngine, type EngineLive } from "../electron/live-engine.ts"
import { deliverDecoded } from "../electron/contracts/native-decoding.ts"
import { drawnWhileOpening, reduceLiveUpdates, type LiveUpdate } from "@mako/sessions/live-content"
import type { LiveSessionState } from "../electron/shared.ts"
import type { SessionProvider } from "../packages/sessions/src/providers/types.ts"
import { ClaudeProvider } from "../packages/sessions/src/providers/claude.ts"
import { CodexProvider } from "../packages/sessions/src/providers/codex.ts"
import { CursorProvider } from "../packages/sessions/src/providers/cursor.ts"
import { DevinCliProvider } from "../packages/sessions/src/providers/devin-cli.ts"
import { DevinLocalProvider } from "../packages/sessions/src/providers/devin-local.ts"
import { GrokProvider } from "../packages/sessions/src/providers/grok.ts"
import { OpenCodeProvider } from "../packages/sessions/src/providers/opencode.ts"
import { decoderFor, readRecording, type Opening, type Prompt, type Recording } from "./native-decoding.ts"

/**
 * Whether a harness's live wire and its own store say the same thing: the
 * capture goes through the live decoder and the live engine's sink, the store
 * through its history reader, and both reach the `ChatMessage`s the window
 * draws. What is compared is that drawing, one line per block, with message
 * boundaries and text chunking left out: a store that writes a reply as two
 * entries and a wire that streams it in forty deltas draw the same.
 *
 * Mako draws its own prompts from the requests it sent, so the live side
 * draws each one the capture recorded where it fell, and a store that loses
 * one, moves it, or reads a steered message as a new turn draws differently.
 */

/** Where Devin.app keeps its user data under a home, as `DevinLocalProvider` defaults to. */
export const DEVIN_APP_USER = join("Library", "Application Support", "Devin", "User")

/**
 * A store reader, reading under `home` instead of the person's own: each
 * harness's reader by its name, and `devin-ide` for the journal Devin.app
 * keeps of the same sessions.
 */
export function storeReader(reader: string, home: string): SessionProvider {
  switch (reader) {
    case "claude": return new ClaudeProvider(home)
    case "codex": return new CodexProvider(home)
    case "cursor": return new CursorProvider(home, {})
    case "devin": return new DevinCliProvider(home)
    case "devin-ide": return new DevinLocalProvider(join(home, DEVIN_APP_USER))
    case "grok": return new GrokProvider(home)
    case "opencode": return new OpenCodeProvider(home)
    default: throw new Error(`No store reader named ${reader}`)
  }
}

/**
 * What the live engine hands the window for this capture, up to the message
 * at `until`. Each launch that resumes the session gets a new decoder and
 * engine, as a new process does, and what it hears while opening is drawn
 * only as the host draws it (`drawnWhileOpening`).
 */
export function liveUpdates(harness: string, recording: Recording, until = recording.messages.length): LiveUpdate[] {
  const source = decoderFor(harness)
  const updates: LiveUpdate[] = []
  /** Where each prompt with a native run id began, for a rewind to cut back to; the host reads the store instead. */
  const runs = new Map<string, number>()
  let replaying = false
  const launch = () => engineSink(harness, (event) => {
    if (event.type === "live-update" || event.type === "live-updates") {
      const sent = event.type === "live-update" ? [event.update] : event.updates
      updates.push(...replaying ? sent.filter(drawnWhileOpening) : sent)
    } else if (event.type === "live-rewound") {
      const at = runs.get(event.run)
      if (at === undefined) throw new Error(`${harness} rewound to turn ${event.run}, which no prompt in the recording names`)
      updates.splice(at)
    }
  })
  let decoder = source.open(recording.session)
  let sink = launch()
  const prompts = (recording.prompts ?? []).filter((prompted) => until === recording.messages.length || prompted.at < until)
  const openings = recording.openings ?? []
  let next = 0
  const prompt = (prompted: Prompt) => {
    if (prompted.steered) return updates.push({ kind: "user", text: prompted.text ?? "", steeringFor: "running" })
    decoder.prompted?.()
    if (prompted.run !== undefined) runs.set(prompted.run, updates.length)
    updates.push(userUpdate(prompted))
  }
  recording.messages.slice(0, until).forEach((message, index) => {
    while (prompts[next]?.at === index) prompt(prompts[next++]!)
    if (openings.some((opening) => opening.at === index)) {
      decoder = source.open(recording.session)
      sink = launch()
    }
    replaying = openings.some((opening) => index >= opening.at && index < (opening.opened ?? Infinity))
    deliverDecoded(decoder.decode(message), sink)
  })
  replaying = false
  for (const prompted of prompts.slice(next)) prompt(prompted)
  return updates
}

/** What the engine would hand the window for the history `opening` replayed, were it drawn: a fresh launch's decoder over those messages alone. */
export function replayedUpdates(harness: string, recording: Recording, opening: Opening): LiveUpdate[] {
  const decoder = decoderFor(harness).open(recording.session)
  const updates: LiveUpdate[] = []
  const sink = engineSink(harness, (event) => {
    if (event.type === "live-update") updates.push(event.update)
    else if (event.type === "live-updates") updates.push(...event.updates)
  })
  for (const message of recording.messages.slice(opening.at, opening.opened)) deliverDecoded(decoder.decode(message), sink)
  return updates
}

function engineSink(harness: string, emit: EngineLive["emit"]) {
  const state: LiveSessionState = {
    id: "compare", harness, nativeId: "compare", cwd: "/", title: "", status: "running",
    connection: "connected", modes: [], currentMode: null, configOptions: [],
  }
  return createLiveEngine<EngineLive>().sink({ state, emit }, { effect: () => undefined })
}

function userUpdate(prompted: Prompt): LiveUpdate {
  const attachments = (prompted.attachments ?? []).map(({ name, mimeType }): AttachmentContent =>
    ({ type: "attachment", name, mimeType, source: { kind: "file", path: name } }))
  return attachments.length ? { kind: "user", text: prompted.text ?? "", attachments } : { kind: "user", text: prompted.text ?? "" }
}

function messagesOf(harness: string, updates: LiveUpdate[]): ChatMessage[] {
  return foldTools(acpBlocksToMessages(reduceLiveUpdates([], updates), false, harness).messages)
}

async function storeMessages(reader: string, harness: string, home: string, path: string): Promise<ChatMessage[]> {
  const thread = await storeReader(reader, home).read(path)
  if (!thread) throw new Error(`${path} is not a session ${reader} reads`)
  return foldTools(threadToMessages(thread.entries, 0, harness))
}

export function liveDrawing(harness: string, recording: Recording): string[] {
  return drawing(messagesOf(harness, liveUpdates(harness, recording)))
}

export async function storeDrawing(reader: string, harness: string, home: string, path: string): Promise<string[]> {
  return drawing(await storeMessages(reader, harness, home, path))
}

/**
 * The live turns before the last launch that resumed, and that launch's
 * replay, drawn. Undefined when the capture never resumes, or resumes
 * without a replay, as Mako resumes Codex (`excludeTurns`): the store's
 * history is drawn instead.
 */
export function replayDrawings(harness: string, recording: Recording): { live: ChatMessage[]; replay: ChatMessage[] } | undefined {
  const opening = recording.openings?.at(-1)
  if (!opening) return undefined
  const replay = messagesOf(harness, replayedUpdates(harness, recording, opening))
  if (!replay.length) return undefined
  return { live: messagesOf(harness, liveUpdates(harness, recording, opening.at)), replay }
}

/**
 * How the markers both sides draw cite native records: the nth marker of a
 * label is the same fact on either side, and must cite the same record on
 * both, or on neither, or live and saved history can't be stitched by it.
 */
export interface MarkerCitations {
  agreed: number
  conflicts: string[]
  oneSided: string[]
}

export function citedMarkers(live: readonly ChatMessage[], store: readonly ChatMessage[]): MarkerCitations {
  const cited = (messages: readonly ChatMessage[]) => {
    const seen = new Map<string, number>()
    const records = new Map<string, string | undefined>()
    for (const { note } of messages) {
      if (!note) continue
      const nth = seen.get(note.label) ?? 0
      seen.set(note.label, nth + 1)
      records.set(`${note.label} #${nth + 1}`, note.source?.record)
    }
    return records
  }
  const saved = cited(store)
  let agreed = 0
  const conflicts: string[] = []
  const oneSided: string[] = []
  for (const [marker, record] of cited(live)) {
    const other = saved.get(marker)
    if (saved.has(marker) && (record === undefined) !== (other === undefined)) oneSided.push(`${marker} cited ${record === undefined ? "saved" : "live"} only`)
    if (record === undefined || other === undefined) continue
    if (record === other) agreed++
    else conflicts.push(`${marker} cites ${record} live and ${other} saved`)
  }
  return { agreed, conflicts, oneSided }
}

/**
 * One line per drawn block, adjacent text and thinking joined. Tools are drawn as the window pairs them, a call with its result
 * on one line; each side namespaces its tool ids its own way, so they are
 * numbered in order of appearance instead.
 */
export function drawing(messages: readonly ChatMessage[]): string[] {
  const lines: string[] = []
  let tools = 0
  let joined: { kind: "text" | "thinking"; text: string } | undefined
  let run: Block[] = []
  const flushText = () => {
    if (joined) lines.push(`${joined.kind}: ${oneLine(joined.text.trim())}`)
    joined = undefined
  }
  const flushTools = () => {
    for (const tool of pairTools(run)) lines.push(toolLine(tool, ++tools))
    run = []
  }
  const join = (kind: "text" | "thinking", text: string) => {
    flushTools()
    if (joined?.kind !== kind) flushText()
    joined = { kind, text: (joined?.text ?? "") + text }
  }
  const push = (line: string) => {
    flushText()
    flushTools()
    lines.push(line)
  }
  for (const message of messages) {
    if (message.role === "user") {
      const text = message.blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("").trim()
      // The store keeps the bytes or a path where Mako kept an asset, so an attachment is drawn as the window labels it.
      const attached = message.blocks.flatMap((block) => block.type === "attachment" ? [` [${block.name} ${block.mimeType}]`] : []).join("")
      if (text || attached) push(`${message.steeringFor ? "steered" : "user"}: ${oneLine(text)}${attached}`)
      continue
    }
    if (message.note) {
      push(`note: ${eventText(message.note)}`)
      continue
    }
    for (const block of message.blocks) {
      if (block.type === "text") join("text", block.text)
      else if (block.type === "thinking") join("thinking", block.thinking)
      else if (block.type === "toolCall" || block.type === "toolResult") {
        flushText()
        run.push(block)
      } else if (block.type === "proposed-plan") push(`plan ${block.status}: ${oneLine(block.text.trim())}`)
      else push(`attachment ${block.name} ${block.mimeType} ${block.source.kind}`)
    }
    flushTools()
    if (message.error) push(`error: ${message.error}`)
  }
  flushText()
  flushTools()
  return lines.filter((line) => line !== "text: " && line !== "thinking: ")
}

function toolLine(tool: ToolCall, index: number): string {
  const flags = [tool.pending && "pending", tool.isError && "error", tool.isCanceled && "canceled", tool.isCutOff && "cut-off"].filter(Boolean)
  return `tool #${index} ${tool.tool.kind} ${tool.name} ${stable(Drawn.parse(tool.arguments))}${flags.map((flag) => ` ${flag}`).join("")}` +
    (tool.result === undefined ? "" : ` -> ${oneLine(tool.result.trim())}`) +
    (tool.details?.length ? ` details=${stable(Drawn.parse(tool.details))}` : "") +
    (tool.attachments?.length ? ` attachments=${tool.attachments.map((attachment) => `${attachment.name} ${attachment.mimeType}`).join(", ")}` : "")
}

const oneLine = (text: string) => text.replaceAll("\n", "\\n")

const JsonText = z.string().transform((text, context): JsonValue => {
  try {
    const value: JsonValue = JSON.parse(text)
    return value
  } catch {
    context.addIssue({ code: "custom", message: "not JSON" })
    return z.NEVER
  }
})
/**
 * Arguments as JSON text read as their value: the same input, pretty or
 * compact, draws the same. A field left `undefined` is dropped, as JSON
 * drops it, rather than failing the whole value.
 */
const Drawn = z.preprocess((value) => {
  const text = JSON.stringify(value)
  return text === undefined ? undefined : JSON.parse(text)
}, z.union([JsonText, z.json()]).optional())

/** JSON with keys in order at every depth, so the same value reads the same from either side. */
function stable(value: JsonValue | undefined): string {
  const keys = new Set<string>()
  JSON.stringify(value, (key: string, item: JsonValue) => {
    keys.add(key)
    return item
  })
  return JSON.stringify(value, [...keys].sort()) ?? ""
}

export interface Difference {
  /** `-` only the live wire draws it, `+` only the store does. */
  side: "-" | "+"
  line: string
}

/** Both drawings in one listing, aligned by longest common subsequence: ` ` both draw it. */
export function aligned(live: readonly string[], store: readonly string[]): { side: " " | Difference["side"]; line: string }[] {
  const table = Array.from({ length: live.length + 1 }, () => Array.from({ length: store.length + 1 }, () => 0))
  for (let left = live.length - 1; left >= 0; left--)
    for (let right = store.length - 1; right >= 0; right--)
      table[left]![right] = live[left] === store[right]
        ? table[left + 1]![right + 1]! + 1
        : Math.max(table[left + 1]![right]!, table[left]![right + 1]!)
  const result: { side: " " | Difference["side"]; line: string }[] = []
  let left = 0
  let right = 0
  while (left < live.length || right < store.length) {
    if (left < live.length && right < store.length && live[left] === store[right]) {
      result.push({ side: " ", line: live[left++]! })
      right++
    } else if (right >= store.length || (left < live.length && table[left + 1]![right]! >= table[left]![right + 1]!))
      result.push({ side: "-", line: live[left++]! })
    else result.push({ side: "+", line: store[right++]! })
  }
  return result
}

/** The lines one side draws and the other doesn't, in order. */
export function differences(live: readonly string[], store: readonly string[]): Difference[] {
  return aligned(live, store).filter((entry): entry is Difference => entry.side !== " ")
}

export const PAIRS_FOLDER = "pairs"

const KnownSchema = z.array(z.object({ side: z.enum(["-", "+"]), line: z.string(), reason: z.string() }))
export type Known = z.infer<typeof KnownSchema>

/**
 * A kept pair: `capture.jsonl` as Mako records the wire, `home/` holding each
 * store the same session wrote, and the differences already understood, each
 * with why it is left. Anything else the sides disagree on fails.
 */
export const PairSchema = z.object({
  harness: z.string(),
  native: z.object({ version: z.string() }),
  about: z.string(),
  /**
   * Each store, read by its `storeReader`: the harness's own, and any other
   * client's record of the same session (Devin.app's journal). `path` is
   * relative to `home/`; `-` in `known` is what only the wire draws.
   */
  stores: z.array(z.object({ reader: z.string(), path: z.string(), known: KnownSchema })).min(1),
  /**
   * For a capture that resumes: what the history the harness replayed while
   * opening draws unlike the live turns before it (`-` only live, `+` only the
   * replay). Its markers must cite the same records as live's.
   */
  replay: z.object({ known: KnownSchema }).optional(),
})
export type Pair = z.infer<typeof PairSchema>

/** The store the harness itself wrote, relative to the pair's `home/`. */
export function ownStore(pair: Pair): string {
  const own = pair.stores.find((store) => store.reader === pair.harness)
  if (!own) throw new Error(`The ${pair.harness} pair keeps no store of the harness's own`)
  return own.path
}

/** What two drawings disagree on beyond the known differences, and the known ones that went away. */
export interface Compared {
  unexplained: Difference[]
  settled: Known
  cited: MarkerCitations
}

function compared(left: readonly ChatMessage[], right: readonly ChatMessage[], known: Known): Compared & { left: string[]; right: string[] } {
  const leftLines = drawing(left)
  const rightLines = drawing(right)
  const found = differences(leftLines, rightLines)
  const key = (difference: Difference) => `${difference.side}${difference.line}`
  const explained = new Set(known.filter((difference) => difference.reason).map(key))
  const seen = new Set(found.map(key))
  return {
    left: leftLines,
    right: rightLines,
    unexplained: found.filter((difference) => !explained.has(key(difference))),
    settled: known.filter((difference) => !seen.has(key(difference))),
    cited: citedMarkers(left, right),
  }
}

/** A kept pair's capture against each of its stores, and its replay against the live turns before it. */
export async function comparePair(folder: string): Promise<{
  pair: Pair
  live: string[]
  stores: (Compared & { reader: string; path: string; store: string[] })[]
  /** The capture's launches that resumed the session. */
  resumes: number
  replay?: Compared & { live: string[]; replay: string[] }
}> {
  const pair = PairSchema.parse(JSON.parse(await readFile(join(folder, "pair.json"), "utf8")))
  const home = join(folder, "home")
  const recording = await readRecording(join(folder, "capture.jsonl"))
  const liveDrawn = messagesOf(pair.harness, liveUpdates(pair.harness, recording))
  const stores = await Promise.all(pair.stores.map(async ({ reader, path, known }) => {
    const { unexplained, settled, cited, right } = compared(liveDrawn, await storeMessages(reader, pair.harness, home, join(home, path)), known)
    return { reader, path, store: right, unexplained, settled, cited }
  }))
  const result: Awaited<ReturnType<typeof comparePair>> = { pair, live: drawing(liveDrawn), stores, resumes: recording.openings?.length ?? 0 }
  const drawn = replayDrawings(pair.harness, recording)
  if (drawn) {
    const { unexplained, settled, cited, left, right } = compared(drawn.live, drawn.replay, pair.replay?.known ?? [])
    result.replay = { unexplained, settled, cited, live: left, replay: right }
  }
  return result
}
