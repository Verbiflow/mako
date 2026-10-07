import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import type { JsonValue } from "../electron/codex-app-json.ts"
import { eventText } from "@mako/sessions/events"
import type { ToolCall } from "@/extend/slots"
import type { Block, ChatMessage } from "@/lib/types"
import { acpBlocksToMessages } from "@/lib/acp-blocks"
import { threadToMessages } from "@/lib/foreign-thread"
import { foldTools, pairTools } from "@/lib/tools"
import { createLiveEngine, type EngineLive } from "../electron/live-engine.ts"
import { deliverDecoded } from "../electron/contracts/native-decoding.ts"
import { reduceLiveUpdates, type LiveUpdate } from "../electron/contracts/live-content.ts"
import type { LiveSessionState } from "../electron/shared.ts"
import type { SessionProvider } from "../packages/sessions/src/providers/types.ts"
import { ClaudeProvider } from "../packages/sessions/src/providers/claude.ts"
import { CodexProvider } from "../packages/sessions/src/providers/codex.ts"
import { CursorProvider } from "../packages/sessions/src/providers/cursor.ts"
import { DevinCliProvider } from "../packages/sessions/src/providers/devin-cli.ts"
import { GrokProvider } from "../packages/sessions/src/providers/grok.ts"
import { OpenCodeProvider } from "../packages/sessions/src/providers/opencode.ts"
import { decoderFor, readRecording, type Recording } from "./native-decoding.ts"

/**
 * Whether a harness's live wire and its own store say the same thing: the
 * capture goes through the live decoder and the live engine's sink, the store
 * through its history reader, and both reach the `ChatMessage`s the window
 * draws. What is compared is that drawing, one line per block, with message
 * boundaries and text chunking left out: a store that writes a reply as two
 * entries and a wire that streams it in forty deltas draw the same.
 *
 * Prompts are left out too. Mako draws its own prompt from the request it
 * sent, not from anything the harness reports back.
 */

/** The store reader for a harness, reading under `home` instead of the person's own. */
export function storeReader(harness: string, home: string): SessionProvider {
  switch (harness) {
    case "claude": return new ClaudeProvider(home)
    case "codex": return new CodexProvider(home)
    case "cursor": return new CursorProvider(home, {})
    case "devin": return new DevinCliProvider(home)
    case "grok": return new GrokProvider(home)
    case "opencode": return new OpenCodeProvider(home)
    default: throw new Error(`No store reader for ${harness}`)
  }
}

/** What the live engine hands the window for this capture. */
export function liveUpdates(harness: string, recording: Recording): LiveUpdate[] {
  const source = decoderFor(harness)
  const decoder = source.open(recording.session)
  const updates: LiveUpdate[] = []
  const state: LiveSessionState = {
    id: "compare", harness, nativeId: "compare", cwd: "/", title: "", status: "running",
    connection: "connected", modes: [], currentMode: null, configOptions: [],
  }
  const live: EngineLive = {
    state,
    emit: (event) => {
      if (event.type === "live-update") updates.push(event.update)
      else if (event.type === "live-updates") updates.push(...event.updates)
    },
  }
  const sink = createLiveEngine<EngineLive>().sink(live, { effect: () => undefined })
  const prompts = new Set(recording.prompts)
  recording.messages.forEach((message, index) => {
    if (prompts.has(index)) updates.push({ kind: "user", text: "" })
    deliverDecoded(decoder.decode(message), sink)
  })
  return updates
}

export function liveDrawing(harness: string, recording: Recording): string[] {
  const blocks = reduceLiveUpdates([], liveUpdates(harness, recording))
  return drawing(foldTools(acpBlocksToMessages(blocks, false, harness).messages))
}

export async function storeDrawing(harness: string, home: string, path: string): Promise<string[]> {
  const thread = await storeReader(harness, home).read(path)
  if (!thread) throw new Error(`${path} is not a ${harness} session`)
  return drawing(foldTools(threadToMessages(thread.entries, 0, harness)))
}

/**
 * One line per drawn block, prompts left out, adjacent text and thinking
 * joined. Tools are drawn as the window pairs them, a call with its result
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
    if (message.role === "user") continue
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
/** Arguments as JSON text read as their value: the same input, pretty or compact, draws the same. */
const Drawn = z.union([JsonText, z.json()]).optional().catch(undefined)

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

/**
 * A kept pair: `capture.jsonl` as Mako records the wire, `home/` holding the
 * store the same session wrote, and the differences already understood, each
 * with why it is left. Anything else the two sides disagree on fails.
 */
export const PairSchema = z.object({
  harness: z.string(),
  native: z.object({ version: z.string() }),
  about: z.string(),
  /** The store file, relative to `home/`. */
  store: z.string(),
  known: z.array(z.object({ side: z.enum(["-", "+"]), line: z.string(), reason: z.string() })),
})
export type Pair = z.infer<typeof PairSchema>

/** What a kept pair's sides disagree on beyond its known differences, and the known ones that went away. */
export async function comparePair(folder: string): Promise<{ pair: Pair; live: string[]; store: string[]; unexplained: Difference[]; settled: Pair["known"] }> {
  const pair = PairSchema.parse(JSON.parse(await readFile(join(folder, "pair.json"), "utf8")))
  const home = join(folder, "home")
  const live = liveDrawing(pair.harness, await readRecording(join(folder, "capture.jsonl")))
  const store = await storeDrawing(pair.harness, home, join(home, pair.store))
  const found = differences(live, store)
  const key = (difference: Difference) => `${difference.side}${difference.line}`
  const known = new Set(pair.known.filter((difference) => difference.reason).map(key))
  const seen = new Set(found.map(key))
  return {
    pair,
    live,
    store,
    unexplained: found.filter((difference) => !known.has(key(difference))),
    settled: pair.known.filter((difference) => !seen.has(key(difference))),
  }
}
