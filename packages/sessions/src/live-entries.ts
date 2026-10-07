import type { AttachmentContent } from "./content.js"
import type { TranscriptEvent } from "./events.js"
import { clip, type EntryBlock, type ThreadEntry, type TurnUsage } from "./format.js"
import { liveToolFinished, reduceLiveUpdates, type LiveBlock, type LiveUpdate } from "./live-content.js"
import { normalizeToolOutput } from "./tool-output.js"

type ToolEntry = EntryBlock & { type: "tool" }
type AssistantEntry = Extract<ThreadEntry, { kind: "assistant" }>

/** A live tool as a saved one, clipped as every store keeps it. */
export function liveToolEntry(block: Extract<LiveBlock, { type: "tool" }>): ToolEntry {
  const tool: ToolEntry = { type: "tool", id: block.id, name: block.name ?? block.title, input: clip(block.input) }
  const output = clip(normalizeToolOutput(block.output))
  if (output) tool.output = output
  if (block.details?.length) tool.details = block.details
  if (block.attachments?.length) tool.attachments = block.attachments
  if (block.status === "failed") tool.error = true
  if (/cancel/i.test(block.status)) tool.canceled = true
  // A finished tool without words still finished; with no output the window draws it pending.
  if (liveToolFinished(block.status)) tool.output ??= ""
  return tool
}

/** A live marker's words, without the fields it left unset. */
export function liveEvent(block: Extract<LiveBlock, { type: "event" }>): TranscriptEvent {
  const event: TranscriptEvent = { label: block.label }
  if (block.detail !== undefined) event.detail = block.detail
  if (block.body !== undefined) event.body = block.body
  if (block.tone !== undefined) event.tone = block.tone
  if (block.source !== undefined) event.source = block.source
  return event
}

export function userEntry(at: string | undefined, id: string | undefined, steeringFor: string | undefined, text: string, attachments: readonly AttachmentContent[] | undefined): ThreadEntry {
  return { kind: "user", ...id && { id }, at, ...steeringFor && { steeringFor }, text, ...attachments?.length && { attachments: [...attachments] } }
}

/** A turn's blocks as saved entries: what the person said, what the agent did, and its markers. `written` says when each block was. */
export function turnEntries(blocks: readonly LiveBlock[], written: WeakMap<LiveBlock, string | undefined>, usage?: TurnUsage): ThreadEntry[] {
  const entries: ThreadEntry[] = []
  let assistant: AssistantEntry | undefined
  let replied: AssistantEntry | undefined
  const reply = (block: LiveBlock): AssistantEntry => {
    if (!assistant) {
      assistant = { kind: "assistant", at: written.get(block), blocks: [] }
      entries.push(assistant)
      replied = assistant
    }
    return assistant
  }
  for (const block of blocks) {
    const at = written.get(block)
    switch (block.type) {
      case "user":
        assistant = undefined
        entries.push(userEntry(at, block.requestId, block.steeringFor, block.text, block.attachments))
        break
      case "provider-turn":
        assistant = undefined
        entries.push({ kind: "event", at, label: block.reason, opensTurn: true })
        break
      case "event":
        assistant = undefined
        entries.push({ kind: "event", at, ...liveEvent(block) })
        break
      case "plan":
        assistant = undefined
        entries.push({ kind: "assistant", at, blocks: [{ type: "tool", name: "Plan", output: "", details: [{ type: "plan", entries: block.entries }] }] })
        break
      case "text":
      case "thinking":
        reply(block).blocks.push({ type: block.type, text: block.text })
        break
      case "attachment":
        reply(block).blocks.push(block.attachment)
        break
      case "proposed-plan":
        reply(block).blocks.push({ type: block.type, id: block.id, text: block.text, status: block.status, ...block.truncated && { truncated: true } })
        break
      case "tool":
        reply(block).blocks.push(liveToolEntry(block))
        break
    }
  }
  if (usage && replied) replied.usage = usage
  return entries
}

/** One turn's live updates as saved entries, each written when `at` says its update was. */
export function liveTurnEntries(updates: LiveUpdate[], at: readonly (string | undefined)[]): ThreadEntry[] {
  const written = new WeakMap<LiveBlock, string | undefined>()
  const blocks = reduceLiveUpdates([], updates, (block, previous, update) => {
    written.set(block, previous && block.type !== "plan" ? written.get(previous) : at[update])
  })
  return turnEntries(blocks, written)
}

/** Live blocks as a saved reply's blocks. Markers, todo lists and prompts are each reader's own. */
export function liveEntryBlocks(blocks: readonly LiveBlock[]): EntryBlock[] {
  const saved: EntryBlock[] = []
  for (const block of blocks) {
    switch (block.type) {
      case "text":
      case "thinking":
        if (block.text) saved.push({ type: block.type, text: block.text })
        break
      case "attachment":
        saved.push(block.attachment)
        break
      case "proposed-plan":
        saved.push({ type: block.type, id: block.id, text: block.text, status: block.status, ...block.truncated && { truncated: true } })
        break
      case "tool":
        saved.push(liveToolEntry(block))
        break
    }
  }
  return saved
}
