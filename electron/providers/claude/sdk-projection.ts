import { claudeProposedPlan } from "./sdk-plan.js"
import { claudeApiErrorEvent } from "@mako/sessions"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { AttachmentContent } from "@mako/sessions"
import type { LiveUpdate } from "../../shared.js"

const MAX_TOOL = 32 * 1024
interface BlockSlot {
  index: number
  type: string
  toolId?: string
  finalized: boolean
}

/**
 * The messages Claude withdrew: a fallback reply names the refused messages
 * it replaces, and the fallback notice at the turn's end lists them all.
 */
export function claudeRetracted(message: SDKMessage): readonly string[] {
  if (message.type === "assistant") return message.supersedes ?? []
  if (message.type === "system" && message.subtype === "model_refusal_fallback") return message.retracted_message_uuids ?? []
  return []
}

/** SDK-owned message types are projected once into the shared transcript contract. */
export class ClaudeProjection {
  private readonly streams = new Map<string, string>()
  private readonly blocks = new Map<string, BlockSlot[]>()
  private readonly finalized = new Set<string>()
  private readonly tools = new Map<string, { id: string; input: string }>()
  /** The blocks each SDK message put in the transcript, by the message's uuid, for Claude to retract. */
  private readonly sources = new Map<string, string[]>()
  /**
   * Blocks streamed this turn by API message id, until that message arrives
   * whole. A refused reply can stop mid-stream and never arrive: it then has
   * no uuid, and this is the only record of what it drew.
   */
  private readonly unfinished = new Map<string, Set<string>>()

  reset(): void {
    this.streams.clear()
    this.blocks.clear()
    this.finalized.clear()
    this.tools.clear()
    this.sources.clear()
    this.unfinished.clear()
  }

  /**
   * Claude retried a refused reply on a fallback model and withdrew what the
   * refused one had sent: those messages' blocks leave the transcript, and
   * so does any reply that only streamed before it was refused. Call before
   * projecting `message`, whose own stream is never withdrawn.
   */
  withdraw(message: SDKMessage): LiveUpdate[] {
    const refusal =
      (message.type === "assistant" && message.supersedes !== undefined) ||
      (message.type === "system" && message.subtype === "model_refusal_fallback")
    if (!refusal) return []
    const own = message.type === "assistant" ? message.message.id : undefined
    const streamed = [...this.unfinished]
      .filter(([id]) => id !== own)
      .flatMap(([id, blocks]) => {
        this.unfinished.delete(id)
        return [...blocks]
      })
    return this.retract(claudeRetracted(message), streamed)
  }

  /** Unknown or already withdrawn uuids change nothing. */
  retract(uuids: readonly string[], streamed: readonly string[] = []): LiveUpdate[] {
    const ids = uuids.flatMap((uuid) => {
      const blocks = this.sources.get(uuid) ?? []
      this.sources.delete(uuid)
      return blocks
    })
    ids.push(...streamed.filter((id) => !ids.includes(id)))
    return ids.length ? [{ kind: "retract", ids }] : []
  }

  private streamed(message: string, id: string): void {
    let blocks = this.unfinished.get(message)
    if (!blocks) {
      blocks = new Set()
      this.unfinished.set(message, blocks)
      if (this.unfinished.size > 64)
        this.unfinished.delete(this.unfinished.keys().next().value ?? "")
    }
    blocks.add(id)
  }

  private remember(uuid: string, updates: LiveUpdate[]): LiveUpdate[] {
    const ids = updates.flatMap((update) =>
      (update.kind === "text" || update.kind === "thinking" || update.kind === "tool" || update.kind === "tool-update") && update.id ? [update.id] : [])
    if (ids.length === 0) return updates
    this.sources.set(uuid, ids)
    if (this.sources.size > 4096) this.sources.delete(this.sources.keys().next().value ?? "")
    return updates
  }

  private slots(id: string): BlockSlot[] {
    let slots = this.blocks.get(id)
    if (!slots) {
      slots = []
      this.blocks.set(id, slots)
      if (this.blocks.size > 1024)
        this.blocks.delete(this.blocks.keys().next().value ?? "")
    }
    return slots
  }

  project(message: SDKMessage): LiveUpdate[] {
    // Nested agent content belongs to that agent. Its parent tool result remains
    // in this transcript; flattening the nested stream creates a false answer.
    if (
      (message.type === "assistant" ||
        message.type === "user" ||
        message.type === "stream_event") &&
      message.parent_tool_use_id
    )
      return []
    if (message.type === "stream_event") {
      const parent = message.parent_tool_use_id ?? "main"
      const event = message.event
      if (event.type === "message_start") {
        this.streams.set(parent, event.message.id)
        if (this.streams.size > 1024)
          this.streams.delete(this.streams.keys().next().value ?? "")
        return []
      }
      const stream = this.streams.get(parent)
      if (!stream || !("index" in event)) return []
      const id = `${stream}:${event.index}`
      if (event.type === "content_block_start") {
        const slots = this.slots(stream)
        if (slots.length < 4096)
          slots.push({
            index: event.index,
            type: event.content_block.type,
            toolId:
              event.content_block.type === "tool_use"
                ? event.content_block.id
                : undefined,
            finalized: false,
          })
      }
      if (
        event.type === "content_block_start" &&
        event.content_block.type === "tool_use"
      ) {
        const tool = event.content_block
        this.streamed(stream, tool.id)
        this.tools.set(id, { id: tool.id, input: "" })
        if (this.tools.size > 4096)
          this.tools.delete(this.tools.keys().next().value ?? "")
        return [
          {
            kind: "tool",
            id: tool.id,
            title: tool.name,
            name: tool.name,
            status: "running",
          },
        ]
      }
      if (event.type !== "content_block_delta") return []
      if (event.delta.type === "text_delta") {
        this.streamed(stream, id)
        return [{ kind: "text", id, text: event.delta.text }]
      }
      if (event.delta.type === "thinking_delta") {
        this.streamed(stream, id)
        return [{ kind: "thinking", id, text: event.delta.thinking }]
      }
      if (event.delta.type === "input_json_delta") {
        const tool = this.tools.get(id)
        if (!tool || tool.input.length >= MAX_TOOL) return []
        tool.input = (tool.input + event.delta.partial_json).slice(0, MAX_TOOL)
        return [{ kind: "tool-update", id: tool.id, input: tool.input }]
      }
      return []
    }
    if (message.type === "result") {
      // A turn's streams have all arrived whole or been withdrawn by now.
      this.unfinished.clear()
      return []
    }
    if (message.type === "assistant") {
      this.unfinished.delete(message.message.id)
      if (this.finalized.has(message.uuid)) return []
      this.finalized.add(message.uuid)
      if (this.finalized.size > 4096)
        this.finalized.delete(this.finalized.values().next().value ?? "")
      // Claude Code composes these itself: an API failure, or filler for a turn with nothing to answer.
      if (message.message.model === "<synthetic>") {
        const text = message.message.content.map((block) => block.type === "text" ? block.text : "").join("")
        if (message.error) return [{ kind: "event", ...claudeApiErrorEvent(message.error, text) }]
        if (text.trim() === "No response requested.") return []
      }
      const slots = this.slots(message.message.id)
      return this.remember(message.uuid, message.message.content.flatMap((block): LiveUpdate[] => {
        let slot = slots.find(
          (candidate) =>
            !candidate.finalized &&
            candidate.type === block.type &&
            (block.type !== "tool_use" || candidate.toolId === block.id)
        )
        if (!slot) {
          slot = {
            index: (slots.at(-1)?.index ?? -1) + 1,
            type: block.type,
            finalized: false,
          }
          if (slots.length < 4096) slots.push(slot)
        }
        slot.finalized = true
        const id = `${message.message.id}:${slot.index}`
        if (block.type === "text")
          return [
            {
              kind: "text",
              id,
              text: block.text,
              replace: true,
            },
          ]
        if (block.type === "thinking")
          return [
            {
              kind: "thinking",
              id,
              text: block.thinking,
              replace: true,
            },
          ]
        if (block.type === "tool_use")
          return [
            {
              kind: "tool",
              id: block.id,
              title: block.name,
              name: block.name,
              status: "running",
              input: JSON.stringify(block.input),
            },
            ...claudeProposedPlan(block),
          ]
        return []
      }))
    }
    if (message.type === "user" && Array.isArray(message.message.content)) {
      const results = message.message.content.flatMap((block): LiveUpdate[] => {
        if (block.type !== "tool_result") return []
        const text: string[] = []
        const attachments: AttachmentContent[] = []
        if (Array.isArray(block.content)) {
          for (const part of block.content) {
            if (part.type === "text") text.push(part.text)
            if (part.type === "image" && part.source.type === "base64") {
              attachments.push({
                type: "attachment",
                name: "Tool image",
                mimeType: part.source.media_type,
                source:
                  part.source.data.length <= 8 * 1024 * 1024
                    ? { kind: "inline", data: part.source.data }
                    : {
                        kind: "unavailable",
                        reason: "Image exceeds the live preview limit",
                      },
              })
            }
          }
        } else if (block.content) text.push(block.content)
        return [
          {
            kind: "tool-update",
            id: block.tool_use_id,
            status: block.is_error ? "failed" : "completed",
            output: text.join("\n"),
            attachments,
          },
        ]
      })
      return message.uuid ? this.remember(message.uuid, results) : results
    }
    return []
  }
}
