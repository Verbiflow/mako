import { promptDelivery, type PendingPrompt } from "@/state/prompt-delivery"
import type { AcpConversation } from "@/state/acp-state"
import type { LiveSnapshot, ChatMessage } from "@/lib/types"
import { acpBlocksToMessages, type AcpPlanEntry } from "@/lib/acp-blocks"
import { threadToMessages } from "@/lib/foreign-thread"
import { reconcileMessages } from "@/lib/reconcile"
import { foldTools } from "@/lib/tools"
import { toExchanges, type Exchange } from "@/lib/exchanges"
import { changedLiveBlockStart, isTurnStart } from "@mako/sessions/live-content"
import { touchedFiles, type TouchedFile } from "@/lib/context-files"
import { nativePromptRequestIds } from "../../electron/contracts/native-prompt-identity"
import { releasedExchanges, type ReleasedTurn } from "@/state/transcript-residency"

export interface LiveProjection {
  messages: ChatMessage[]
  exchanges: Exchange[]
  plan: AcpPlanEntry[]
  files: TouchedFile[]
}
type ProjectionInput = Pick<LiveSnapshot, "blocks" | "base" | "baseCoveredBlocks" | "history"> & {
  session: Pick<LiveSnapshot["session"], "status" | "harness">
  requests?: LiveSnapshot["requests"]
  releasedTurns?: ReleasedTurn[]
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
      { ...held.cursor, offset: snapshot.history?.blockStart, token: snapshot.history?.token }
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
    { start: localCovered(snapshot), turn: snapshot.history?.turnStart ?? 0, plan: [],
      offset: snapshot.history?.blockStart, token: snapshot.history?.token }
  )
  const base = snapshot.base
    ? threadToMessages(
        snapshot.base.entries,
        snapshot.base.start,
        snapshot.base.ref.harness
      )
    : []
  if (snapshot.base && snapshot.requests) {
    const ids = nativePromptRequestIds(snapshot.base.ref, snapshot.requests)
    const seen = new Set<string>()
    for (const message of base)
      if (message.role === "user" && message.anchor?.id && !message.steeringFor) {
        if (seen.has(message.anchor.id)) ids.delete(message.anchor.id)
        seen.add(message.anchor.id)
      }
    for (const message of base)
      if (message.role === "user" && message.anchor?.id && !message.steeringFor) {
        const requestId = ids.get(message.anchor.id)
        if (requestId) message.requestId = requestId
      }
  }
  if (snapshot.history) {
    const token = snapshot.history.token
    for (const message of base)
      message.blocks = message.blocks.map(block => block.type === "toolResult" && block.rest && "at" in block.rest
        ? { ...block, rest: { length: block.rest.length, live: { token, at: { kind: "base", ...block.rest.at } } } }
        : block)
  }
  const messages = reconcileMessages(
    previous?.messages ?? [],
    foldTools([...base, ...live.messages])
  )
  const result: LiveProjection = {
    messages,
    files: touchedFiles(messages),
    exchanges: releasedExchanges(toExchanges(messages, previous?.exchanges), snapshot.releasedTurns),
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
    held.input.releasedTurns !== input.releasedTurns ||
    held.input.baseCoveredBlocks !== input.baseCoveredBlocks ||
    held.input.history?.blockStart !== input.history?.blockStart ||
    held.input.history?.token !== input.history?.token ||
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
    localCovered(input),
    input.blocks.findLastIndex(isTurnStart)
  )
  let turn = previous?.cursor.turn ?? input.history?.turnStart ?? 0
  let plan = previous?.cursor.plan ?? []
  for (let index = previous?.cursor.start ?? localCovered(input); index < start; index++) {
    const block = input.blocks[index]
    if (isTurnStart(block)) turn++
    if (block?.type === "plan") plan = block.entries
  }
  const opener = input.blocks[start]
  const absolute = start + (input.history?.blockStart ?? 0)
  const id =
    opener?.type === "user"
      ? opener.requestId
        ? `acp-request-${opener.requestId}`
        : `acp-user-${absolute}`
      : opener?.type === "provider-turn"
        ? `acp-turn-${absolute}`
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
      history: conversation.history,
      releasedTurns: conversation.releasedTurns,
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

function localCovered(input: ProjectionInput): number {
  return Math.max(0, (input.baseCoveredBlocks ?? 0) - (input.history?.blockStart ?? 0))
}
