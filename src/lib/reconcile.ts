import type { Block, ChatMessage, MessageOrigin } from "@/lib/types"

/**
 * Keep message identity stable across host re-serializations.
 *
 * The host rebuilds the whole message array whenever a turn ends or a tool
 * returns, so every object arrives new. `Turn` is memoized on identity, which
 * means without this step a single tool result re-renders — and re-parses the
 * markdown of — every turn in the session.
 *
 * Reconciling by content lets the unchanged tail of a long conversation keep
 * its previous objects and skip rendering entirely. The comparison is
 * deliberately structural rather than a general deep equality or hash. Text
 * is compared directly so in-place provider rewrites cannot preserve stale
 * output merely because the replacement has the same length.
 */
export function reconcileMessages(
  previous: ChatMessage[],
  next: ChatMessage[]
): ChatMessage[] {
  if (previous.length === 0) return next

  const byId = new Map(previous.map((message) => [message.id, message]))
  let reused = 0
  const out = next.map((message) => {
    const old = byId.get(message.id)
    if (old && sameMessage(old, message)) {
      reused += 1
      return old
    }
    return message
  })

  // Nothing was reusable (a compaction, a branch switch): take the new array
  // wholesale rather than handing back a copy with identical contents.
  if (
    out.length === previous.length &&
    out.every((message, index) => message === previous[index])
  )
    return previous
  return reused === 0 ? next : out
}

function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  if (a.id !== b.id) return false
  if (a === b) return true
  if (
    a.model !== b.model ||
    a.provider !== b.provider ||
    a.toolName !== b.toolName
  )
    return false
  if (a.role !== b.role) return false
  if (a.requestId !== b.requestId || a.steeringFor !== b.steeringFor || a.opensTurn !== b.opensTurn) return false
  if (a.timestamp !== b.timestamp) return false
  if (a.error !== b.error) return false
  if (a.isError !== b.isError) return false
  if (a.streaming !== b.streaming) return false
  if (a.toolCallId !== b.toolCallId) return false
  if (a.anchor?.index !== b.anchor?.index || a.anchor?.id !== b.anchor?.id || a.anchor?.at !== b.anchor?.at) return false
  if (!sameOrigin(a.origin, b.origin)) return false
  if (a.blocks.length !== b.blocks.length) return false
  for (let i = 0; i < a.blocks.length; i += 1) {
    if (!sameBlock(a.blocks[i], b.blocks[i])) return false
  }
  return true
}

/** What "Show original" reads: a merge that adds an entry's stream frames changes it. */
function sameOrigin(a: MessageOrigin | undefined, b: MessageOrigin | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.path !== b.path || a.entries.length !== b.entries.length) return false
  return a.entries.every((entry, index) => {
    const other = b.entries[index]!
    return entry.id === other.id && entry.type === other.type && entry.label === other.label &&
      JSON.stringify([entry.record, entry.stream, entry.at]) === JSON.stringify([other.record, other.stream, other.at])
  })
}

function sameBlock(a: Block, b: Block): boolean {
  if (a === b) return true
  switch (a.type) {
    case "proposed-plan":
      return (
        b.type === "proposed-plan" &&
        a.id === b.id &&
        a.text === b.text &&
        a.status === b.status &&
        a.truncated === b.truncated
      )
    case "text":
      return b.type === "text" && a.text === b.text
    case "thinking":
      return b.type === "thinking" && a.thinking === b.thinking
    case "attachment":
      return b.type === "attachment" && JSON.stringify(a) === JSON.stringify(b)
    case "toolCall":
      return (
        b.type === "toolCall" &&
        a.id === b.id &&
        a.name === b.name &&
        a.at === b.at &&
        (a.arguments === b.arguments ||
          JSON.stringify(a.arguments) === JSON.stringify(b.arguments))
      )
    case "toolResult":
      return (
        b.type === "toolResult" &&
        a.id === b.id &&
        a.name === b.name &&
        a.text === b.text &&
        a.isError === b.isError &&
        a.isCanceled === b.isCanceled &&
        a.isCutOff === b.isCutOff &&
        a.streaming === b.streaming &&
        a.endedAt === b.endedAt &&
        JSON.stringify(a.attachments) === JSON.stringify(b.attachments) &&
        JSON.stringify(a.details) === JSON.stringify(b.details)
      )
  }
}
