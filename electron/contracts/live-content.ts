import { z } from "zod"
import {
  AttachmentContentSchema,
  ToolDetailSchema,
  ProposedPlanSchema,
  MAX_PROPOSED_PLAN_LENGTH,
  type AttachmentContent,
  type ToolDetail,
} from "@mako/sessions/content"
import { NativeEventSourceSchema, sameSetupEvent } from "@mako/sessions/events"

const plan = z.array(z.object({ content: z.string(), status: z.string() }))
/**
 * The call never returned a result: its turn ended while it was still
 * running. `status` and `output` are what closed the row, not the call's own.
 */
const unfinished = z.literal(true).optional()
/** `TranscriptEvent` from `@mako/sessions/events`. */
const transcriptEvent = {
  source: NativeEventSourceSchema.optional(),
  label: z.string(),
  detail: z.string().optional(),
  body: z.string().optional(),
  tone: z.enum(["warning", "error"]).optional(),
  setup: z.boolean().optional(),
}
export const LiveUpdateSchema = z.discriminatedUnion("kind", [
  ProposedPlanSchema.omit({ type: true }).extend({
    kind: z.literal("proposed-plan"),
    text: z.string(),
    replace: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("user"),
    steeringFor: z.string().optional(),
    provider: z.string().optional(),
    requestId: z.string().optional(),
    contextFiles: z.array(z.string()).optional(),
    text: z.string(),
    attachments: z.array(AttachmentContentSchema).optional(),
  }),
  z.object({
    kind: z.literal("text"),
    text: z.string(),
    id: z.string().optional(),
    replace: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("thinking"),
    text: z.string(),
    id: z.string().optional(),
    replace: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("attachment"),
    attachment: AttachmentContentSchema,
  }),
  z.object({
    kind: z.literal("tool"),
    id: z.string(),
    title: z.string(),
    /** The harness's own tool name, which `identifyTool` resolves; ACP calls it nothing. */
    name: z.string().optional(),
    /** ACP's kind for the call (`execute`, `read`), when the harness speaks ACP. */
    toolKind: z.string().optional(),
    status: z.string(),
    input: z.string().optional(),
    output: z.string().optional(),
    details: z.array(ToolDetailSchema).optional(),
    attachments: z.array(AttachmentContentSchema).optional(),
    unfinished,
  }),
  z.object({
    kind: z.literal("tool-update"),
    id: z.string(),
    title: z.string().optional(),
    status: z.string().optional(),
    /** The whole input; it wins over `inputAppend`. */
    input: z.string().optional(),
    /** Text that continues the input the call has. */
    inputAppend: z.string().optional(),
    /** The whole output; it wins over `outputAppend`. */
    output: z.string().optional(),
    /** Text that continues the output; the call keeps its last `MAX_STREAMED_TOOL_OUTPUT` characters. */
    outputAppend: z.string().optional(),
    details: z.array(ToolDetailSchema).optional(),
    attachments: z.array(AttachmentContentSchema).optional(),
    unfinished,
  }),
  z.object({ kind: z.literal("plan"), entries: plan }),
  /** The provider started a turn on its own; `reason` is what it reported as the cause. */
  z.object({ kind: z.literal("provider-turn"), reason: z.string() }),
  /**
   * A marker the provider gave the conversation (`TranscriptEvent`); a saved
   * history's `event` entry. `id` names the native event it came from: the
   * same id again in the turn replaces the marker, so a replayed or amended
   * event is drawn once. A setup marker the conversation already shows is
   * dropped, whichever turn or session start reports it again.
   */
  z.object({
    kind: z.literal("event"),
    id: z.string().optional(),
    ...transcriptEvent,
  }),
  /** The provider withdrew content it had sent: the turn's text, thinking and tool blocks with these ids go. */
  z.object({ kind: z.literal("retract"), ids: z.array(z.string()).min(1) }),
])
export type LiveUpdate = z.infer<typeof LiveUpdateSchema>
export const LiveBlockSchema = z.discriminatedUnion("type", [
  ProposedPlanSchema,
  z.object({
    type: z.literal("user"),
    steeringFor: z.string().optional(),
    provider: z.string().optional(),
    requestId: z.string().optional(),
    contextFiles: z.array(z.string()).optional(),
    text: z.string(),
    attachments: z.array(AttachmentContentSchema).optional(),
  }),
  z.object({
    type: z.literal("text"),
    text: z.string(),
    id: z.string().optional(),
  }),
  z.object({
    type: z.literal("thinking"),
    text: z.string(),
    id: z.string().optional(),
  }),
  z.object({
    type: z.literal("attachment"),
    attachment: AttachmentContentSchema,
  }),
  z.object({
    type: z.literal("tool"),
    /** A view preview, resolved from the immutable retained snapshot on expansion. */
    historyRest: z
      .object({
        index: z.number().int().nonnegative(),
        length: z.number().nonnegative(),
      })
      .optional(),
    /** Display-only immutable content identity, including a resolved detail. */
    historyVersion: z.string().optional(),
    id: z.string(),
    title: z.string(),
    name: z.string().optional(),
    toolKind: z.string().optional(),
    status: z.string(),
    input: z.string().optional(),
    output: z.string().optional(),
    details: z.array(ToolDetailSchema).optional(),
    attachments: z.array(AttachmentContentSchema).optional(),
    unfinished,
  }),
  z.object({ type: z.literal("plan"), entries: plan }),
  z.object({ type: z.literal("provider-turn"), reason: z.string() }),
  z.object({
    type: z.literal("event"),
    id: z.string().optional(),
    ...transcriptEvent,
  }),
])
export type LiveBlock = z.infer<typeof LiveBlockSchema>

/** A call has ended once its status is one of these; providers spell them differently. */
export function liveToolFinished(status: string): boolean {
  return status === "failed" || /cancel|complete|done/i.test(status)
}

/** A block that opens a turn: the user's prompt, or the cause of one the provider started itself. */
export function isTurnStart(block: LiveBlock | undefined): boolean {
  return (
    (block?.type === "user" && !block.steeringFor) ||
    block?.type === "provider-turn"
  )
}

const changes = new WeakMap<
  LiveBlock[],
  { source: WeakRef<LiveBlock[]>; from: number }
>()

export function changedLiveBlockStart(
  previous: LiveBlock[],
  next: LiveBlock[]
): number {
  if (previous === next) return next.length
  const change = changes.get(next)
  if (change?.source.deref() === previous) return change.from
  let index = 0
  while (
    index < previous.length &&
    index < next.length &&
    previous[index] === next[index]
  )
    index++
  return index
}

export function mergeLiveUpdates(
  previous: LiveUpdate | undefined,
  next: LiveUpdate
): LiveUpdate | undefined {
  if (!previous || previous.kind !== next.kind) return undefined
  if (
    (next.kind === "text" || next.kind === "thinking") &&
    (previous.kind === "text" || previous.kind === "thinking") &&
    previous.id === next.id
  ) {
    return {
      ...next,
      text: next.replace ? next.text : previous.text + next.text,
      replace: next.replace || previous.replace,
    }
  }
  if (
    previous.kind === "tool-update" &&
    next.kind === "tool-update" &&
    previous.id === next.id
  ) {
    const input = mergeStream(previous.input, previous.inputAppend, next.input, next.inputAppend, Infinity)
    const output = mergeStream(previous.output, previous.outputAppend, next.output, next.outputAppend, MAX_STREAMED_TOOL_OUTPUT)
    const merged: LiveUpdate = {
      ...previous,
      title: next.title ?? previous.title,
      status: next.status ?? previous.status,
      input: input.whole,
      inputAppend: input.append,
      output: output.whole,
      outputAppend: output.append,
      details: next.details ?? previous.details,
      attachments: next.attachments ?? previous.attachments,
    }
    if (next.unfinished) merged.unfinished = true
    return merged
  }
  return undefined
}

/** Streamed tool output a call keeps: the newest text, which is what a running command is doing. */
export const MAX_STREAMED_TOOL_OUTPUT = 32 * 1024

function tail(value: string, limit: number): string {
  return value.length > limit ? value.slice(-limit) : value
}

/** One field of an update: its whole new value, or what continues the current one. */
interface FieldChange {
  whole?: string
  append?: string
}

/** Two updates to one field as one: applying the result equals applying both in turn. */
function mergeStream(
  whole: string | undefined,
  append: string | undefined,
  nextWhole: string | undefined,
  nextAppend: string | undefined,
  limit: number
): FieldChange {
  if (nextWhole !== undefined) return { whole: nextWhole }
  if (nextAppend === undefined) return { whole, append }
  if (whole !== undefined) return { whole: tail(whole + nextAppend, limit) }
  return { append: tail((append ?? "") + nextAppend, limit) }
}

/** A field's value after an update: the whole value, or the current one continued. */
function streamed(current: string | undefined, whole: string | undefined, append: string | undefined, limit: number): string | undefined {
  if (whole !== undefined) return whole
  if (append === undefined) return current
  return tail((current ?? "") + append, limit)
}

/**
 * How a field travels when its whole value is sent again: nothing when it
 * is unchanged, the new end when it continues the current value, the whole
 * value otherwise. An append of output is cut to the limit, so only an
 * output within it travels as one.
 */
function streamForm(current: string | undefined, whole: string | undefined, limit: number): { whole?: string; append?: string } | undefined {
  if (whole === undefined || current === undefined || whole.length > limit) return undefined
  if (whole === current) return {}
  if (whole.length > current.length && whole.startsWith(current)) return { append: whole.slice(current.length) }
  return undefined
}

/** Updates waiting for the next batch, and about how many characters they carry. */
export interface LivePending {
  updates: LiveUpdate[]
  pendingCharacters: number
}

/** A batch flushes before it holds more than this many updates or characters. */
export const LIVE_BATCH_LIMITS = { updates: 128, characters: 256_000 } as const

/**
 * Adds `update` to the batch, merged into the last update when it continues
 * it. `full`: the batch must flush first, and `update` was not added.
 */
export function queueLiveUpdate(pending: LivePending, update: LiveUpdate): "queued" | "full" {
  const last = pending.updates.at(-1)
  const merged = mergeLiveUpdates(last, update)
  if (last && merged) {
    const characters = pending.pendingCharacters - liveUpdateWeight(last) + liveUpdateWeight(merged)
    if (characters <= LIVE_BATCH_LIMITS.characters) {
      pending.updates[pending.updates.length - 1] = merged
      pending.pendingCharacters = characters
      return "queued"
    }
  }
  const characters = liveUpdateWeight(update)
  if (pending.updates.length && (pending.updates.length >= LIVE_BATCH_LIMITS.updates || pending.pendingCharacters + characters > LIVE_BATCH_LIMITS.characters))
    return "full"
  pending.updates.push(update)
  pending.pendingCharacters += characters
  return "queued"
}

/** About how many characters an update adds to a batch, without serializing it. */
export function liveUpdateWeight(update: LiveUpdate): number {
  switch (update.kind) {
    case "text":
    case "thinking":
    case "proposed-plan":
      return 32 + update.text.length
    case "user":
      return 64 + update.text.length + attachmentsWeight(update.attachments)
    case "attachment":
      return 32 + attachmentWeight(update.attachment)
    case "tool":
    case "tool-update":
      return 64 + update.id.length + (update.title?.length ?? 0) +
        (update.input?.length ?? 0) + (update.output?.length ?? 0) +
        (update.kind === "tool-update" ? (update.inputAppend?.length ?? 0) + (update.outputAppend?.length ?? 0) : 0) +
        detailsWeight(update.details) + attachmentsWeight(update.attachments)
    case "plan":
      return 32 + planWeight(update.entries)
    case "provider-turn":
      return 32 + update.reason.length
    case "event":
      return 64 + update.label.length + (update.detail?.length ?? 0) + (update.body?.length ?? 0)
    case "retract":
      return 32 + update.ids.reduce((sum, id) => sum + id.length + 3, 0)
  }
}

function planWeight(entries: readonly { content: string; status: string }[]): number {
  return entries.reduce((sum, entry) => sum + 32 + entry.content.length + entry.status.length, 0)
}

function detailsWeight(details: readonly ToolDetail[] | undefined): number {
  let sum = 0
  for (const detail of details ?? []) {
    switch (detail.type) {
      case "diff":
        sum += 48 + detail.path.length + (detail.oldText?.length ?? 0) + detail.newText.length
        break
      case "terminal":
        sum += 32 + detail.terminalId.length
        break
      case "location":
        sum += 48 + detail.path.length
        break
      case "plan":
        sum += 32 + planWeight(detail.entries)
        break
    }
  }
  return sum
}

function attachmentsWeight(attachments: readonly AttachmentContent[] | undefined): number {
  let sum = 0
  for (const attachment of attachments ?? []) sum += attachmentWeight(attachment)
  return sum
}

function attachmentWeight(attachment: AttachmentContent): number {
  const base = 64 + attachment.name.length + attachment.mimeType.length + (attachment.id?.length ?? 0)
  switch (attachment.source.kind) {
    case "file":
      return base + attachment.source.path.length + (attachment.source.originalPath?.length ?? 0)
    case "url":
      return base + attachment.source.url.length
    case "inline":
      return base + attachment.source.data.length
    case "unavailable":
      return base + attachment.source.reason.length
  }
}

/** What a tool block gained this batch through appends alone; see `deliverLiveUpdates`. */
export interface ToolGrowth {
  input?: string
  output?: string
}

export const ToolGrowthSchema = z.object({ input: z.string().optional(), output: z.string().optional() })

/** The tool block after `growth`, by the rule a `tool-update` append follows. */
export function growTool(block: Extract<LiveBlock, { type: "tool" }>, growth: ToolGrowth): Extract<LiveBlock, { type: "tool" }> {
  return {
    ...block,
    input: streamed(block.input, undefined, growth.input, Infinity),
    output: streamed(block.output, undefined, growth.output, MAX_STREAMED_TOOL_OUTPUT),
  }
}

/** One batch as the host delivers it; see `deliverLiveUpdates`. */
export interface LiveDelivery {
  blocks: LiveBlock[]
  /** The updates as they travel: each whole value that continues its block's is sent as the new end. */
  updates: LiveUpdate[]
  /**
   * Tool blocks, by index, whose input and output only grew by appends and
   * whose other fields stayed as they were, so storage can append too.
   */
  grown: Map<number, ToolGrowth>
}

/** The host and renderer use the same pure projection. One allocation per delivered batch. */
export function reduceLiveUpdates(
  blocks: LiveBlock[],
  updates: LiveUpdate[]
): LiveBlock[] {
  return reduce(blocks, updates, undefined)
}

/**
 * A batch reduced as the host delivers it. Whoever holds `blocks` reaches
 * the same result from `updates` with `reduceLiveUpdates`, so a harness that
 * sends a call's whole output again and one that streams only the new end
 * cost a receiver the same.
 */
export function deliverLiveUpdates(blocks: LiveBlock[], updates: LiveUpdate[]): LiveDelivery {
  const delivery: LiveDelivery = { blocks, updates: [], grown: new Map() }
  delivery.blocks = reduce(blocks, updates, { delivery, rewritten: new Set() })
  return delivery
}

interface Delivering {
  delivery: LiveDelivery
  /** Blocks stored whole this batch, which no later append can describe. */
  rewritten: Set<number>
  shifted?: boolean
}

/** A tool update as it travels against its block. */
interface ToolDelivery {
  update: Extract<LiveUpdate, { kind: "tool-update" }>
  /** The update only grew the block's input or output. */
  grows: boolean
}

/** The update as it travels against `block`, and whether it only grew the block. */
function toolDelivery(block: Extract<LiveBlock, { type: "tool" }>, update: Extract<LiveUpdate, { kind: "tool-update" }>): ToolDelivery {
  const input = streamForm(block.input, update.input, Infinity)
  const output = streamForm(block.output, update.output, MAX_STREAMED_TOOL_OUTPUT)
  const title = update.title !== undefined && update.title === block.title
  const status = update.status !== undefined && update.status === block.status
  let sent = update
  if (input || output || title || status) {
    sent = { ...update }
    if (title) delete sent.title
    if (status) delete sent.status
    if (input) {
      delete sent.input
      if (input.append === undefined) delete sent.inputAppend
      else sent.inputAppend = input.append
    }
    if (output) {
      delete sent.output
      if (output.append === undefined) delete sent.outputAppend
      else sent.outputAppend = output.append
    }
  }
  const grows =
    sent.input === undefined &&
    sent.output === undefined &&
    sent.title === undefined &&
    sent.status === undefined &&
    sent.details === undefined &&
    sent.attachments === undefined &&
    (!sent.unfinished || block.unfinished === true)
  return { update: sent, grows }
}

function reduce(
  blocks: LiveBlock[],
  updates: LiveUpdate[],
  delivering: Delivering | undefined
): LiveBlock[] {
  if (!updates.length) return blocks
  const next = [...blocks]
  let from = blocks.length
  const replace = (index: number, block: LiveBlock) => {
    const at = index < 0 ? next.length : index
    from = Math.min(from, at)
    next[at] = block
  }
  const rewrite = (index: number) => {
    if (!delivering) return
    delivering.rewritten.add(index)
    delivering.delivery.grown.delete(index)
  }
  const tools = new Map<string, number>()
  let turnStart = next.length - 1
  while (turnStart >= 0 && !isTurnStart(next[turnStart])) turnStart--
  for (let index = turnStart + 1; index < next.length; index++) {
    const block = next[index]!
    if (block.type === "tool") tools.set(block.id, index)
  }
  const findCurrent = (matches: (block: LiveBlock) => boolean) => {
    for (let index = turnStart + 1; index < next.length; index++)
      if (matches(next[index]!)) return index
    return -1
  }
  for (const received of updates) {
    let update = received
    const last = next.at(-1)
    if (update.kind === "tool-update" && delivering) {
      const index = tools.get(update.id) ?? -1
      const block = next[index]
      if (block?.type === "tool") {
        const sent = toolDelivery(block, update)
        update = sent.update
        if (!sent.grows || delivering.shifted || delivering.rewritten.has(index)) rewrite(index)
        else if (index < blocks.length) {
          const growth = delivering.delivery.grown.get(index) ?? {}
          if (update.inputAppend !== undefined) growth.input = (growth.input ?? "") + update.inputAppend
          if (update.outputAppend !== undefined)
            growth.output = tail((growth.output ?? "") + update.outputAppend, MAX_STREAMED_TOOL_OUTPUT)
          delivering.delivery.grown.set(index, growth)
        }
      }
    } else if (update.kind === "tool" && delivering) rewrite(tools.get(update.id) ?? next.length)
    else if (update.kind === "retract" && delivering) {
      delivering.shifted = true
      delivering.delivery.grown.clear()
    }
    delivering?.delivery.updates.push(update)
    switch (update.kind) {
      case "user": {
        if (!update.steeringFor) {
          tools.clear()
          turnStart = next.length
        }
        const user: LiveBlock = {
          type: "user",
          provider: update.provider,
          requestId: update.requestId,
          contextFiles: update.contextFiles,
          text: update.text,
          attachments: update.attachments,
        }
        if (update.steeringFor) user.steeringFor = update.steeringFor
        replace(-1, user)
        break
      }
      case "text":
      case "thinking": {
        const index = update.id
          ? findCurrent(
              (block) => block.type === update.kind && block.id === update.id
            )
          : last?.type === update.kind
            ? next.length - 1
            : -1
        const previous = next[index]
        const text =
          previous?.type === update.kind && !update.replace
            ? previous.text + update.text
            : update.text
        const block: LiveBlock = { type: update.kind, text, id: update.id }
        replace(index, block)
        break
      }
      case "proposed-plan": {
        const index = findCurrent(
          (block) => block.type === "proposed-plan" && block.id === update.id
        )
        const previous = next[index]
        const text =
          previous?.type === "proposed-plan" && !update.replace
            ? previous.text + update.text
            : update.text
        const block: LiveBlock = {
          type: "proposed-plan",
          id: update.id,
          status: update.status,
          text: text.slice(0, MAX_PROPOSED_PLAN_LENGTH),
          truncated: Boolean(
            update.truncated ||
            text.length > MAX_PROPOSED_PLAN_LENGTH ||
            (!update.replace &&
              previous?.type === "proposed-plan" &&
              previous.truncated)
          ),
        }
        replace(index, block)
        break
      }
      case "attachment":
        replace(-1, { type: "attachment", attachment: update.attachment })
        break
      case "tool": {
        const index = tools.get(update.id) ?? -1
        const block: LiveBlock = {
          type: "tool",
          id: update.id,
          title: update.title,
          status: update.status,
          name: update.name,
          toolKind: update.toolKind,
          input: update.input,
          output: update.output,
          details: update.details,
          attachments: update.attachments,
        }
        if (update.unfinished) block.unfinished = true
        tools.set(update.id, index >= 0 ? index : next.length)
        replace(index, block)
        break
      }
      case "tool-update": {
        const index = tools.get(update.id) ?? -1
        const block = next[index]
        if (block?.type !== "tool") break
        const updated: LiveBlock = {
          ...block,
          title: update.title ?? block.title,
          status: update.status ?? block.status,
          input: streamed(block.input, update.input, update.inputAppend, Infinity),
          output: streamed(block.output, update.output, update.outputAppend, MAX_STREAMED_TOOL_OUTPUT),
          details: update.details ?? block.details,
          attachments: update.attachments ?? block.attachments,
        }
        if (update.unfinished) updated.unfinished = true
        replace(index, updated)
        break
      }
      case "plan": {
        const index = findCurrent((block) => block.type === "plan")
        const block: LiveBlock = { type: "plan", entries: update.entries }
        replace(index, block)
        break
      }
      case "provider-turn":
        tools.clear()
        turnStart = next.length
        replace(-1, { type: "provider-turn", reason: update.reason })
        break
      case "event": {
        if (
          update.setup &&
          next.some(
            (candidate) =>
              candidate.type === "event" && sameSetupEvent(candidate, update)
          )
        )
          break
        const block: LiveBlock = {
          type: "event",
          source: update.source,
          label: update.label,
          detail: update.detail,
          body: update.body,
          tone: update.tone,
        }
        if (update.setup) block.setup = true
        if (update.id) block.id = update.id
        replace(
          update.id
            ? findCurrent(
                (candidate) =>
                  candidate.type === "event" && candidate.id === update.id
              )
            : -1,
          block
        )
        break
      }
      case "retract": {
        const ids = new Set(update.ids)
        let kept = turnStart + 1
        for (let index = turnStart + 1; index < next.length; index++) {
          const block = next[index]!
          const withdrawn =
            (block.type === "text" ||
              block.type === "thinking" ||
              block.type === "tool") &&
            block.id !== undefined &&
            ids.has(block.id)
          if (withdrawn) from = Math.min(from, kept)
          else next[kept++] = block
        }
        if (kept === next.length) break
        next.length = kept
        tools.clear()
        for (let index = turnStart + 1; index < next.length; index++) {
          const block = next[index]!
          if (block.type === "tool") tools.set(block.id, index)
        }
        break
      }
    }
  }
  if (from === blocks.length && next.length === blocks.length) return blocks
  changes.set(next, { source: new WeakRef(blocks), from })
  return next
}
