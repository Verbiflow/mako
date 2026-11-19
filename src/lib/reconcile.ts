import type { Block, ChatMessage, MessageOrigin, OriginEntry } from "@/lib/types"

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
 *
 * What a block carries from its entry (a call's arguments, a result's
 * attachments and details, where a message's entries are recorded) is the same
 * object while the entry is: only an entry read again, a new object saying
 * perhaps the same, is serialized to compare. Projected whole, a long
 * conversation once serialized every call's arguments twice over.
 *
 * A message that changed keeps the blocks that didn't, so a reply that gained
 * a paragraph hands back the same calls above it.
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
    return old ? keepingBlocks(old, message) : message
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

/** `next` with each block `old` held at the same place saying the same, as `old`'s. */
function keepingBlocks(old: ChatMessage, next: ChatMessage): ChatMessage {
  let kept = 0
  const blocks = next.blocks.map((block, index) => {
    const held = old.blocks[index]
    if (!held || held === block || !sameBlock(held, block) || !sameRest(held, block)) return block
    kept += 1
    return held
  })
  return kept ? { ...next, blocks } : next
}

/**
 * What `sameBlock` leaves to the rest of its message to say changed: how a call is identified, and where a result's
 * whole content, its media and its command's end are. A block kept on its own answers for these too.
 */
function sameRest(a: Block, b: Block): boolean {
  if (a.type === "toolCall") return b.type === "toolCall" && a.tool === b.tool && a.kind === b.kind
  if (a.type === "toolResult")
    return b.type === "toolResult" && a.exitCode === b.exitCode && a.cwd === b.cwd &&
      sameValue(a.rest, b.rest) && sameValue(a.media, b.media)
  return true
}

/** The same value: the same object, or one that serializes the same. */
function sameValue<Value>(a: Value, b: Value): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
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
      sameValue(entry.record, other.record) && sameValue(entry.stream, other.stream) && sameAddress(entry.at, other.at)
  })
}

/** An address is drawn anew with its message: its two fields say whether it's the same. */
function sameAddress(a: OriginEntry["at"], b: OriginEntry["at"]): boolean {
  if (a === b) return true
  if (!a || !b || a.kind !== b.kind) return false
  return a.kind === "live" ? b.kind === "live" && a.index === b.index : b.kind === "base" && a.id === b.id
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
      return b.type === "attachment" && sameValue(a, b)
    case "toolCall":
      return (
        b.type === "toolCall" &&
        a.id === b.id &&
        a.name === b.name &&
        a.at === b.at &&
        sameValue(a.arguments, b.arguments)
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
        sameValue(a.attachments, b.attachments) &&
        sameValue(a.details, b.details)
      )
  }
}
