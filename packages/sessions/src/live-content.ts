import { z } from "zod"
import {
  AttachmentContentSchema,
  ToolDetailSchema,
  ProposedPlanSchema,
  MAX_PROPOSED_PLAN_LENGTH,
  type AttachmentContent,
  type ToolDetail,
} from "./content.js"
import { sameSetupEvent } from "./events.js"
import { type ToolEffect } from "./tool-effects.js"
import { effects, joined, plan, providerTurnFields, RecordRefSchema, transcriptEventFields as transcriptEvent, unfinished, type Entry, type EntryOf } from "./entries.js"

/** A moment in epoch milliseconds, stamped by the host where it received or sent the content. */
const at = z.number().nonnegative().optional()
/**
 * The stream frames the update was decoded from (`Entry.stream`). The block
 * an update places names its frames and those of each update before it.
 */
const stream = RecordRefSchema.optional()
const providerTurn = { ...providerTurnFields, at, stream }
export const LiveUpdateSchema = z.discriminatedUnion("kind", [
  ProposedPlanSchema.omit({ type: true }).extend({
    kind: z.literal("proposed-plan"),
    text: z.string(),
    replace: z.boolean().optional(),
    stream,
  }),
  z.object({
    kind: z.literal("user"),
    steeringFor: z.string().optional(),
    provider: z.string().optional(),
    requestId: z.string().optional(),
    /** When the host sent it (epoch milliseconds), stamped where it is sent so the reducer never reads a clock. */
    at,
    /** The harness's id for the message; a chunk right after one with the same id continues it. */
    messageId: z.string().optional(),
    contextFiles: z.array(z.string()).optional(),
    text: z.string(),
    attachments: z.array(AttachmentContentSchema).optional(),
    stream,
  }),
  z.object({
    kind: z.literal("text"),
    text: z.string(),
    id: z.string().optional(),
    replace: z.boolean().optional(),
    stream,
  }),
  z.object({
    kind: z.literal("thinking"),
    text: z.string(),
    id: z.string().optional(),
    replace: z.boolean().optional(),
    stream,
  }),
  z.object({
    kind: z.literal("attachment"),
    attachment: AttachmentContentSchema,
    stream,
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
    effects,
    stream,
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
    /** Text that continues the output. */
    outputAppend: z.string().optional(),
    details: z.array(ToolDetailSchema).optional(),
    attachments: z.array(AttachmentContentSchema).optional(),
    unfinished,
    effects,
    stream,
  }),
  z.object({ kind: z.literal("plan"), entries: plan, stream }),
  /**
   * The provider started a turn on its own; `reason` is what it reported as
   * the cause, in its words, `cause` what settled when it says, and `body`
   * what the work left to read. `at` is when the host learned of it.
   */
  z.object({ kind: z.literal("provider-turn"), ...providerTurn }),
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
    stream,
  }),
  /** The provider withdrew content it had sent: the turn's text, thinking and tool blocks with these ids go. */
  z.object({ kind: z.literal("retract"), ids: z.array(z.string()).min(1) }),
])
export type LiveUpdate = z.infer<typeof LiveUpdateSchema>

/**
 * Whether the host draws `update` while a conversation it already shows is
 * opening. A harness resuming its session replays the history then, which
 * the saved history already shows; only a setup notice is about this launch.
 */
export function drawnWhileOpening(update: LiveUpdate): boolean {
  return update.kind === "event" && update.setup === true
}

/** A `provider-turn` update as its entry, without the fields it left unset. */
function providerTurnBlock(update: Extract<LiveUpdate, { kind: "provider-turn" }>): Entry {
  const block: EntryOf<"provider-turn"> = { type: "provider-turn", reason: update.reason }
  if (update.cause) block.cause = update.cause
  if (update.body) block.body = update.body
  if (update.at !== undefined) block.at = update.at
  if (update.source) block.source = update.source
  return block
}

/**
 * A call has ended once its status is one of these; providers spell them
 * differently. A saved call whose record holds no result yet has none: its
 * session may still be running it.
 */
export function liveToolFinished(status: string | undefined): boolean {
  return status !== undefined && (status === "failed" || /cancel|complete|done/i.test(status))
}

/** The words a row names a call by: the harness's title, else its tool's name. */
export function toolTitle(entry: EntryOf<"tool">): string {
  return entry.title ?? entry.name ?? ""
}

/** A block that opens a turn: the user's prompt, or the cause of one the provider started itself. */
export function isTurnStart(block: Entry | undefined): boolean {
  return (
    (block?.type === "user" && !block.steeringFor) ||
    block?.type === "provider-turn"
  )
}

const changes = new WeakMap<
  Entry[],
  { source: WeakRef<Entry[]>; from: number }
>()

export function changedEntryStart(
  previous: Entry[],
  next: Entry[]
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
    const merged: LiveUpdate = {
      ...next,
      text: next.replace ? next.text : previous.text + next.text,
      replace: next.replace || previous.replace,
    }
    const frames = joined(previous.stream, next.stream)
    if (frames) merged.stream = frames
    return merged
  }
  if (
    previous.kind === "tool-update" &&
    next.kind === "tool-update" &&
    previous.id === next.id
  ) {
    const input = mergeStream(previous.input, previous.inputAppend, next.input, next.inputAppend)
    const output = mergeStream(previous.output, previous.outputAppend, next.output, next.outputAppend)
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
      effects: next.effects ?? previous.effects,
    }
    if (next.unfinished) merged.unfinished = true
    const frames = joined(previous.stream, next.stream)
    if (frames) merged.stream = frames
    return merged
  }
  return undefined
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
  nextAppend: string | undefined
): FieldChange {
  if (nextWhole !== undefined) return { whole: nextWhole }
  if (nextAppend === undefined) return { whole, append }
  if (whole !== undefined) return { whole: whole + nextAppend }
  return { append: (append ?? "") + nextAppend }
}

/** A field's value after an update: the whole value, or the current one continued. */
function streamed(current: string | undefined, whole: string | undefined, append: string | undefined): string | undefined {
  if (whole !== undefined) return whole
  if (append === undefined) return current
  return (current ?? "") + append
}

/**
 * How a field travels when its whole value is sent again: nothing when it
 * is unchanged, the new end when it continues the current value, the whole
 * value otherwise.
 */
function streamForm(current: string | undefined, whole: string | undefined): { whole?: string; append?: string } | undefined {
  if (whole === undefined || current === undefined) return undefined
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
        detailsWeight(update.details) + attachmentsWeight(update.attachments) + effectsWeight(update.effects)
    case "plan":
      return 32 + planWeight(update.entries)
    case "provider-turn":
      return 32 + update.reason.length + (update.body?.length ?? 0)
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

function effectsWeight(effects: readonly ToolEffect[] | undefined): number {
  let sum = 0
  for (const effect of effects ?? []) {
    switch (effect.kind) {
      case "create":
      case "write":
        sum += 32 + effect.path.length + (effect.content?.length ?? 0)
        break
      case "modify":
        sum += 32 + effect.path.length + (effect.patch?.length ?? 0) + (effect.edits?.reduce((total, edit) => total + 16 + edit.old.length + edit.new.length, 0) ?? 0)
        break
      case "delete":
      case "read":
        sum += 32 + effect.path.length
        break
      case "rename":
        sum += 32 + effect.from.length + effect.to.length
        break
      case "command":
        sum += 64 + effect.command.length + (effect.cwd?.length ?? 0) + (effect.named?.reduce((total, path) => total + path.length + 3, 0) ?? 0)
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
export function growTool(block: Extract<Entry, { type: "tool" }>, growth: ToolGrowth): Extract<Entry, { type: "tool" }> {
  return {
    ...block,
    input: streamed(block.input, undefined, growth.input),
    output: streamed(block.output, undefined, growth.output),
  }
}

/** One batch as the host delivers it; see `deliverLiveUpdates`. */
export interface LiveDelivery {
  blocks: Entry[]
  /** The updates as they travel: each whole value that continues its block's is sent as the new end. */
  updates: LiveUpdate[]
  /**
   * Tool blocks, by index, whose input and output only grew by appends and
   * whose other fields stayed as they were, so storage can append too.
   */
  grown: Map<number, ToolGrowth>
}

/**
 * Called for each block a reduction places: `previous` is the block it
 * replaced, absent for a new one, and `update` the index of the update that
 * placed it. A saved history keeps what blocks don't carry, such as when each
 * was written, by it.
 */
export type LivePlacement = (block: Entry, previous: Entry | undefined, update: number) => void

/** The host, the renderer and a store that saved the wire use the same pure projection. One allocation per delivered batch. */
export function reduceLiveUpdates(
  blocks: Entry[],
  updates: LiveUpdate[],
  placed?: LivePlacement
): Entry[] {
  return reduce(blocks, updates, undefined, placed)
}

/**
 * A batch reduced as the host delivers it. Whoever holds `blocks` reaches
 * the same result from `updates` with `reduceLiveUpdates`, so a harness that
 * sends a call's whole output again and one that streams only the new end
 * cost a receiver the same.
 */
export function deliverLiveUpdates(blocks: Entry[], updates: LiveUpdate[]): LiveDelivery {
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
function toolDelivery(block: Extract<Entry, { type: "tool" }>, update: Extract<LiveUpdate, { kind: "tool-update" }>): ToolDelivery {
  const input = streamForm(block.input, update.input)
  const output = streamForm(block.output, update.output)
  const title = update.title !== undefined && update.title === block.title
  const status = update.status !== undefined && update.status === block.status
  const effects = update.effects !== undefined && sameEffects(update.effects, block.effects)
  let sent = update
  if (input || output || title || status || effects) {
    sent = { ...update }
    if (title) delete sent.title
    if (status) delete sent.status
    if (effects) delete sent.effects
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
    sent.effects === undefined &&
    (!sent.unfinished || block.unfinished === true)
  return { update: sent, grows }
}

/** Whether a call's restated effects are the ones its block holds; the window has no `node:util`. */
function sameEffects(next: readonly ToolEffect[], current: readonly ToolEffect[] | undefined): boolean {
  return next === current || (current !== undefined && next.length === current.length && JSON.stringify(next) === JSON.stringify(current))
}

/** How an update names `block` within its turn, for those found by name. */
function nameOf(block: Entry): string | undefined {
  switch (block.type) {
    case "text":
    case "thinking":
    case "proposed-plan":
    case "event":
      return block.id === undefined ? undefined : `${block.type}:${block.id}`
    case "plan":
      return "plan"
    default:
      return undefined
  }
}

function reduce(
  blocks: Entry[],
  updates: LiveUpdate[],
  delivering: Delivering | undefined,
  placed?: LivePlacement
): Entry[] {
  if (!updates.length) return blocks
  const next = [...blocks]
  let from = blocks.length
  let current = 0
  // The current turn's blocks an update finds by name, where they sit: a
  // replayed run reduces as one batch of hundreds of thousands of updates,
  // so a scan of the turn per update was quadratic.
  const named = new Map<string, number>()
  const replace = (index: number, block: Entry) => {
    const at = index < 0 ? next.length : index
    from = Math.min(from, at)
    const previous = index < 0 ? undefined : next[at]
    const update = updates[current]!
    const stream = joined(previous?.stream, update.kind === "retract" ? undefined : update.stream)
    if (stream) block.stream = stream
    placed?.(block, previous, current)
    next[at] = block
    const key = nameOf(block)
    if (key !== undefined && !named.has(key)) named.set(key, at)
  }
  const rewrite = (index: number) => {
    if (!delivering) return
    delivering.rewritten.add(index)
    delivering.delivery.grown.delete(index)
  }
  const tools = new Map<string, number>()
  let turnStart = next.length - 1
  while (turnStart >= 0 && !isTurnStart(next[turnStart])) turnStart--
  const reindex = () => {
    tools.clear()
    named.clear()
    for (let at = turnStart + 1; at < next.length; at++) {
      const block = next[at]!
      if (block.type === "tool") tools.set(block.id, at)
      const key = nameOf(block)
      if (key !== undefined && !named.has(key)) named.set(key, at)
    }
  }
  reindex()
  const findCurrent = (key: string) => named.get(key) ?? -1
  for (; current < updates.length; current++) {
    let update = updates[current]!
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
            growth.output = (growth.output ?? "") + update.outputAppend
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
        const previous = next.at(-1)
        if (update.messageId && previous?.type === "user" && previous.messageId === update.messageId) {
          const joined = { ...previous, text: previous.text + update.text }
          if (update.attachments?.length) joined.attachments = [...previous.attachments ?? [], ...update.attachments]
          replace(next.length - 1, joined)
          break
        }
        if (!update.steeringFor) {
          tools.clear()
          named.clear()
          turnStart = next.length
        }
        const user: Entry = {
          type: "user",
          provider: update.provider,
          requestId: update.requestId,
          contextFiles: update.contextFiles,
          text: update.text,
          attachments: update.attachments,
        }
        if (update.messageId) user.messageId = update.messageId
        if (update.steeringFor) user.steeringFor = update.steeringFor
        if (update.at !== undefined) user.at = update.at
        replace(-1, user)
        break
      }
      case "text":
      case "thinking": {
        const index = update.id
          ? findCurrent(`${update.kind}:${update.id}`)
          : last?.type === update.kind
            ? next.length - 1
            : -1
        const previous = next[index]
        const text =
          previous?.type === update.kind && !update.replace
            ? previous.text + update.text
            : update.text
        const block: Entry = { type: update.kind, text, id: update.id }
        replace(index, block)
        break
      }
      case "proposed-plan": {
        const index = findCurrent(`proposed-plan:${update.id}`)
        const previous = next[index]
        const text =
          previous?.type === "proposed-plan" && !update.replace
            ? previous.text + update.text
            : update.text
        const block: Entry = {
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
        const block: Entry = {
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
        if (update.effects) block.effects = update.effects
        tools.set(update.id, index >= 0 ? index : next.length)
        replace(index, block)
        break
      }
      case "tool-update": {
        const index = tools.get(update.id) ?? -1
        const block = next[index]
        if (block?.type !== "tool") break
        const updated: Entry = {
          ...block,
          title: update.title ?? block.title,
          status: update.status ?? block.status,
          input: streamed(block.input, update.input, update.inputAppend),
          output: streamed(block.output, update.output, update.outputAppend),
          details: update.details ?? block.details,
          attachments: update.attachments ?? block.attachments,
        }
        if (update.unfinished) updated.unfinished = true
        if (update.effects) updated.effects = update.effects
        replace(index, updated)
        break
      }
      case "plan": {
        const index = findCurrent("plan")
        const block: Entry = { type: "plan", entries: update.entries }
        replace(index, block)
        break
      }
      case "provider-turn":
        tools.clear()
        named.clear()
        turnStart = next.length
        replace(-1, providerTurnBlock(update))
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
        const block: Entry = {
          type: "event",
          source: update.source,
          label: update.label,
          detail: update.detail,
          body: update.body,
          tone: update.tone,
        }
        if (update.setup) block.setup = true
        if (update.cause) block.cause = update.cause
        if (update.limit) block.limit = update.limit
        if (update.id) block.id = update.id
        replace(update.id ? findCurrent(`event:${update.id}`) : -1, block)
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
        reindex()
        break
      }
    }
  }
  if (from === blocks.length && next.length === blocks.length) return blocks
  changes.set(next, { source: new WeakRef(blocks), from })
  return next
}
