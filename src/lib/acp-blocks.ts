import { liveToolName } from "@/lib/tools"
import type { Block, ChatMessage } from "@/lib/types"

export interface AcpPlanEntry {
  content: string
  status: string
}

import type { LiveBlock as AcpBlock } from "../../electron/contracts/live-content"
export type { LiveBlock as AcpBlock } from "../../electron/contracts/live-content"

export interface AcpConversation {
  messages: ChatMessage[]
  plan: AcpPlanEntry[]
}

export function acpBlocksToMessages(
  blocks: AcpBlock[],
  running: boolean,
  provider?: string,
  cursor?: { start: number; turn: number; plan: AcpPlanEntry[] }
): AcpConversation {
  const messages: ChatMessage[] = []
  const prompts = new Map<string, string>()
  let plan: AcpPlanEntry[] = cursor?.plan ?? []
  let assistant: ChatMessage | null = null
  let turn = cursor?.turn ?? 0
  let turnProvider = provider

  const append = (block: Block, index: number) => {
    if (!assistant) {
      assistant = {
        id: `acp-assistant-${index}`,
        role: "assistant",
        blocks: [],
      }
      if (turnProvider) assistant.provider = turnProvider
      messages.push(assistant)
    }
    assistant.blocks.push(block)
  }

  for (let index = cursor?.start ?? 0; index < blocks.length; index += 1) {
    const block = blocks[index]!
    switch (block.type) {
      case "user":
        turnProvider = block.provider ?? provider
        if (!block.steeringFor) turn += 1
        assistant = null
        messages.push({
          id: block.requestId
            ? `acp-request-${block.requestId}`
            : `acp-user-${index}`,
          requestId: block.requestId,
          role: "user",
          steeringFor: block.steeringFor
            ? prompts.get(block.steeringFor)
            : undefined,
          blocks: [
            { type: "text", text: block.text },
            ...(block.attachments ?? []),
          ],
        })
        if (block.requestId)
          prompts.set(block.requestId, `acp-request-${block.requestId}`)
        break
      case "proposed-plan":
        append(block, index)
        break
      case "text":
        append({ type: "text", text: block.text }, index)
        break
      case "attachment":
        append(block.attachment, index)
        break
      case "thinking":
        append({ type: "thinking", thinking: block.text }, index)
        break
      case "tool": {
        const name = liveToolName(block.toolKind, block.title)
        append(
          {
            type: "toolCall",
            id: `${turn}:${block.id}`,
            name,
            kind: block.toolKind,
            arguments: block.input,
          },
          index
        )
        const failed = block.status === "failed"
        const canceled = /cancel/i.test(block.status)
        const finished =
          failed || canceled || /complete|done/i.test(block.status)
        if (
          finished ||
          block.output !== undefined ||
          block.attachments?.length ||
          block.details?.length
        ) {
          append(
            {
              type: "toolResult",
              id: `${turn}:${block.id}`,
              name,
              text: block.output ?? (failed ? block.title : ""),
              isError: failed,
              isCanceled: canceled,
              streaming: !finished,
              attachments: block.attachments,
              details: block.details,
            },
            index
          )
        }
        break
      }
      case "plan":
        plan = block.entries
        append(
          {
            type: "toolResult",
            id: `plan-${index}`,
            name: "Plan",
            text: "",
            details: [{ type: "plan", entries: block.entries }],
          },
          index
        )
        break
    }
  }

  const last = messages.at(-1)
  if (running && last?.role === "assistant") last.streaming = true
  return { messages, plan }
}
