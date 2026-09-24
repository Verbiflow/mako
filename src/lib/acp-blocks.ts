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
  cursor?: { start: number; turn: number; plan: AcpPlanEntry[]; offset?: number; token?: string }
): AcpConversation {
  const messages: ChatMessage[] = []
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
    const absolute = index + (cursor?.offset ?? 0)
    switch (block.type) {
      case "user":
        turnProvider = block.provider ?? provider
        if (!block.steeringFor) turn += 1
        assistant = null
        messages.push({
          id: block.requestId
            ? `acp-request-${block.requestId}`
            : `acp-user-${absolute}`,
          requestId: block.requestId,
          role: "user",
          steeringFor: block.steeringFor
            ? `acp-request-${block.steeringFor}`
            : undefined,
          blocks: [
            { type: "text", text: block.text },
            ...(block.attachments ?? []),
          ],
        })
        break
      case "proposed-plan":
        append(block, absolute)
        break
      case "text":
        append({ type: "text", text: block.text }, absolute)
        break
      case "attachment":
        append(block.attachment, absolute)
        break
      case "thinking":
        append({ type: "thinking", thinking: block.text }, absolute)
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
          absolute
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
              rest: block.historyRest && cursor?.token ? { length: block.historyRest.length,
                live: { token: cursor.token, at: { kind: "live", index: block.historyRest.index } } } : undefined,
            },
            absolute
          )
        }
        break
      }
      case "plan":
        plan = block.entries
        append(
          {
            type: "toolResult",
            id: `plan-${absolute}`,
            name: "Plan",
            text: "",
            details: [{ type: "plan", entries: block.entries }],
          },
          absolute
        )
        break
    }
  }

  const last = messages.at(-1)
  if (running && last?.role === "assistant") last.streaming = true
  return { messages, plan }
}
