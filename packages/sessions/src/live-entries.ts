import type { TranscriptEvent } from "./events.js"
import { clip, type EntryBlock } from "./format.js"
import { liveToolFinished, type LiveBlock } from "./live-content.js"
import { normalizeToolOutput } from "./tool-output.js"

type ToolEntry = EntryBlock & { type: "tool" }

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
