import { promptDelivery, type PendingPrompt } from "@/state/prompt-delivery"
import type { AcpConversation } from "@/state/acp-state"
import type { LiveSnapshot, ChatMessage } from "@/lib/types"
import { acpBlocksToMessages, type AcpPlanEntry } from "@/lib/acp-blocks"
import { threadToMessages } from "@/lib/foreign-thread"
import { reconcileMessages } from "@/lib/reconcile"
import { foldTools } from "@/lib/tools"
import { toExchanges, type Exchange } from "@/lib/exchanges"
import { changedLiveBlockStart } from "../../electron/contracts/live-content"
import { touchedFiles, type TouchedFile } from "@/lib/context-files"

export interface LiveProjection {
  messages: ChatMessage[]
  exchanges: Exchange[]
  plan: AcpPlanEntry[]
  files: TouchedFile[]
}
type ProjectionInput = Pick<LiveSnapshot, "blocks" | "base" | "baseCoveredBlocks"> & {
  session: Pick<LiveSnapshot["session"], "status" | "harness">
  requests?: LiveSnapshot["requests"]
}
interface ProjectionCache {
  input: ProjectionInput
  pending?: PendingPrompt[]
  starting: boolean
  cursor: { start: number; turn: number; plan: AcpPlanEntry[] }
  messageStart: number
  exchangeStart: number
  tools: ReturnType<typeof toolInputs>
}
const cache = new WeakMap<LiveProjection, ProjectionCache>()

export function projectLive(
  snapshot: ProjectionInput,
  previous?: LiveProjection,
  pendingPrompts?: PendingPrompt[]
): LiveProjection {
  const held = previous && cache.get(previous)
  if (previous && held && canProjectTail(held, snapshot, pendingPrompts)) {
    if (snapshot.blocks === held.input.blocks) return previous
    const live = acpBlocksToMessages(
      snapshot.blocks,
      snapshot.session.status === "running",
      snapshot.session.harness,
      held.cursor
    )
    const tail = reconcileMessages(
      previous.messages.slice(held.messageStart),
      live.messages
    )
    const messages = [...previous.messages.slice(0, held.messageStart), ...tail]
    const tools = toolInputs(tail)
    const sameTools =
      tools.length === held.tools.length &&
      tools.every((tool, index) => {
        const old = held.tools[index]
        return (
          old?.at === tool.at &&
          old.id === tool.id &&
          old.name === tool.name &&
          old.input === tool.input
        )
      })
    const result: LiveProjection = {
      messages,
      files: sameTools ? previous.files : touchedFiles(messages),
      exchanges: [
        ...previous.exchanges.slice(0, held.exchangeStart),
        ...toExchanges(tail, previous.exchanges.slice(held.exchangeStart)),
      ],
      plan: live.plan,
    }
    remember(result, snapshot, pendingPrompts, false, held)
    return result
  }
  const { starting } = promptDelivery({ ...snapshot, pendingPrompts })
  const blocks = starting
    ? [
        ...snapshot.blocks,
        {
          type: "user" as const,
          requestId: starting.id,
          text: starting.displayText ?? starting.text,
          attachments: starting.attachments.map((attachment) => ({
            type: "attachment" as const,
            name: attachment.name,
            mimeType: attachment.mimeType,
            source: attachment.path
              ? { kind: "file" as const, path: attachment.path }
              : attachment.data
                ? { kind: "inline" as const, data: attachment.data }
                : {
                    kind: "unavailable" as const,
                    reason: "Attachment is being prepared",
                  },
          })),
        },
      ]
    : snapshot.blocks
  const live = acpBlocksToMessages(
    blocks,
    snapshot.session.status === "running",
    snapshot.session.harness,
    { start: snapshot.baseCoveredBlocks ?? 0, turn: 0, plan: [] }
  )
  const base = snapshot.base
    ? threadToMessages(
        snapshot.base.entries,
        snapshot.base.start,
        snapshot.base.ref.harness
      )
    : []
  const messages = reconcileMessages(
    previous?.messages ?? [],
    foldTools([...base, ...live.messages])
  )
  const result: LiveProjection = {
    messages,
    files: touchedFiles(messages),
    exchanges: toExchanges(messages, previous?.exchanges),
    plan: live.plan,
  }
  remember(result, snapshot, pendingPrompts, Boolean(starting))
  return result
}

function canProjectTail(
  held: ProjectionCache,
  input: ProjectionInput,
  pending?: PendingPrompt[]
): boolean {
  if (
    held.starting ||
    held.pending !== pending ||
    held.input.base !== input.base ||
    held.input.baseCoveredBlocks !== input.baseCoveredBlocks ||
    held.input.requests !== input.requests ||
    held.input.session.status !== input.session.status ||
    held.input.session.harness !== input.session.harness ||
    input.blocks[held.cursor.start] !== held.input.blocks[held.cursor.start] ||
    changedLiveBlockStart(held.input.blocks, input.blocks) < held.cursor.start
  )
    return false
  const prompts = new Set<string>()
  for (let index = held.cursor.start; index < input.blocks.length; index++) {
    const block = input.blocks[index]
    if (block?.type !== "user") continue
    if (block.steeringFor && !prompts.has(block.steeringFor)) return false
    if (block.requestId) prompts.add(block.requestId)
  }
  return true
}

function remember(
  result: LiveProjection,
  input: ProjectionInput,
  pending: PendingPrompt[] | undefined,
  starting: boolean,
  previous?: ProjectionCache
): void {
  const start = Math.max(
    input.baseCoveredBlocks ?? 0,
    input.blocks.findLastIndex(
      (block) => block.type === "user" && !block.steeringFor
    )
  )
  let turn = previous?.cursor.turn ?? 0
  let plan = previous?.cursor.plan ?? []
  for (let index = previous?.cursor.start ?? input.baseCoveredBlocks ?? 0; index < start; index++) {
    const block = input.blocks[index]
    if (block?.type === "user" && !block.steeringFor) turn++
    if (block?.type === "plan") plan = block.entries
  }
  const user = input.blocks[start]
  const id =
    user?.type === "user"
      ? user.requestId
        ? `acp-request-${user.requestId}`
        : `acp-user-${start}`
      : undefined
  const unchanged = previous?.cursor.start === start
  const messageStart = unchanged
    ? previous.messageStart
    : id
      ? Math.max(
          0,
          result.messages.findIndex((message) => message.id === id)
        )
      : start >= input.blocks.length ? result.messages.length : 0
  cache.set(result, {
    input: { ...input, session: { ...input.session } },
    pending,
    starting,
    cursor: { start, turn, plan },
    messageStart,
    tools: toolInputs(result.messages.slice(messageStart)),
    exchangeStart: unchanged
      ? previous.exchangeStart
      : id
        ? Math.max(
            0,
            result.exchanges.findIndex((exchange) => exchange.id === id)
          )
        : start >= input.blocks.length ? result.exchanges.length : 0,
  })
}

function toolInputs(messages: ChatMessage[]) {
  return messages.flatMap((message, at) =>
    message.blocks.flatMap((block) =>
      block.type === "toolCall"
        ? [{ at, id: block.id, name: block.name, input: block.arguments }]
        : []
    )
  )
}

export function projectAcp(conversation: AcpConversation): LiveProjection {
  return projectLive(
    {
      blocks: conversation.blocks,
      base: conversation.base ?? null,
      baseCoveredBlocks: conversation.baseCoveredBlocks,
      requests: conversation.requests,
      session:
        conversation.kind === "live"
          ? conversation.session
          : { status: "starting", harness: conversation.harness },
    },
    conversation.projection,
    conversation.pendingPrompts
  )
}
