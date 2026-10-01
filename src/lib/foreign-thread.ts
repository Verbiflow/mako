import { eventText } from "@mako/sessions/events"
import { identifyTool } from "@mako/sessions/tool-identity"
import { cachedToolIdentity } from "@/lib/tools"
import type { Block, ChatMessage, MessageAnchor, ThreadEntry } from "@/lib/types"

function isInputTool(name: string): boolean {
  return identifyTool({ name }).kind === "question"
}

export function pendingThreadInput(entries: ThreadEntry[]): string | null {
  for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = entries[entryIndex]
    if (entry?.kind !== "assistant") continue
    for (
      let blockIndex = entry.blocks.length - 1;
      blockIndex >= 0;
      blockIndex -= 1
    ) {
      const block = entry.blocks[blockIndex]
      if (block?.type !== "tool" || !isInputTool(block.name)) continue
      return block.output === undefined ? block.name : null
    }
  }
  return null
}

export function threadToMessages(
  entries: ThreadEntry[],
  indexStart = 0,
  provider?: string
): ChatMessage[] {
  const messages: ChatMessage[] = []

  for (let localIndex = 0; localIndex < entries.length; localIndex += 1) {
    const entry = entries[localIndex]!
    const entryIndex = indexStart + localIndex
    const messageId = entry.id
      ? `native-${entry.kind}-${entry.id}`
      : `foreign-entry-${entryIndex}`
    // What a fork names: the provider's own message id when the store has
    // one, its timestamp otherwise, with the index as the unchanged-store hint.
    const anchor: MessageAnchor = { index: entryIndex }
    if (entry.id) anchor.id = entry.id
    if (entry.at) anchor.at = entry.at
    if (entry.kind === "user") {
      const message: ChatMessage = {
        id: messageId,
        role: "user",
        steeringFor: entry.steeringFor
          ? `native-user-${entry.steeringFor}`
          : undefined,
        blocks: [
          { type: "text", text: entry.text },
          ...(entry.attachments ?? []),
        ],
        anchor,
      }
      if (entry.at) message.timestamp = Date.parse(entry.at) || undefined
      messages.push(message)
      continue
    }
    if (entry.kind === "event") {
      const message: ChatMessage = {
        id: messageId,
        role: "system",
        blocks: [{ type: "text", text: eventText(entry) }],
      }
      if (!entry.opensTurn)
        message.note = { label: entry.label, detail: entry.detail, body: entry.body, tone: entry.tone }
      if (entry.opensTurn) {
        message.opensTurn = true
        if (entry.at) message.timestamp = Date.parse(entry.at) || undefined
      }
      messages.push(message)
      continue
    }
    const blocks: Block[] = []
    for (
      let blockIndex = 0;
      blockIndex < entry.blocks.length;
      blockIndex += 1
    ) {
      const block = entry.blocks[blockIndex]!
      if (block.type === "attachment" || block.type === "proposed-plan")
        blocks.push(block)
      if (block.type === "text") blocks.push({ type: "text", text: block.text })
      if (block.type === "thinking")
        blocks.push({ type: "thinking", thinking: block.text })
      if (block.type === "tool") {
        const callId = `${messageId}-tool-${block.id ?? blockIndex}`
        const tool = cachedToolIdentity(block, { harness: provider, name: block.name, input: block.input })
        blocks.push({
          type: "toolCall",
          id: callId,
          name: block.name,
          tool,
          arguments: tool.input ?? block.input,
        })
        if (
          block.output !== undefined ||
          Boolean(block.attachments?.length) ||
          Boolean(block.details?.length) ||
          Boolean(block.contentOmitted || block.attachmentsOmitted || block.outputLength) ||
          block.error === true ||
          block.canceled === true
        ) {
          const result: Block = {
            type: "toolResult",
            id: callId,
            name: block.name,
            text: block.output ?? "",
            attachments: block.attachments,
            details: block.details,
          }
          if (block.error) result.isError = true
          if (block.canceled) result.isCanceled = true
          const trimmedOutput =
            block.outputLength !== undefined &&
            block.output !== undefined &&
            block.outputLength > block.output.length
          if (trimmedOutput || block.attachmentsOmitted || block.contentOmitted)
            result.rest = {
              length: block.outputLength ?? block.output?.length ?? 0,
              at: { entry: entryIndex, block: blockIndex },
            }
          blocks.push(result)
        }
      }
    }
    if (blocks.length === 0) continue
    const message: ChatMessage = {
      id: messageId,
      role: "assistant",
      blocks,
      anchor,
    }
    if (provider) message.provider = provider
    if (entry.model) message.model = entry.model
    if (entry.at) message.timestamp = Date.parse(entry.at) || undefined
    messages.push(message)
  }
  return messages
}
