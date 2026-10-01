import { z } from "zod"
import {
  AttachmentContentSchema,
  ToolDetailSchema,
  ProposedPlanSchema,
  MAX_PROPOSED_PLAN_LENGTH,
} from "@mako/sessions/content"
import { sameSetupEvent } from "@mako/sessions/events"

const plan = z.array(z.object({ content: z.string(), status: z.string() }))
/**
 * The call never returned a result: its turn ended while it was still
 * running. `status` and `output` are what closed the row, not the call's own.
 */
const unfinished = z.literal(true).optional()
/** `TranscriptEvent` from `@mako/sessions/events`. */
const transcriptEvent = {
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
    input: z.string().optional(),
    output: z.string().optional(),
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
  z.object({ kind: z.literal("event"), id: z.string().optional(), ...transcriptEvent }),
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
    historyRest: z.object({ index: z.number().int().nonnegative(), length: z.number().nonnegative() }).optional(),
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
  z.object({ type: z.literal("event"), id: z.string().optional(), ...transcriptEvent }),
])
export type LiveBlock = z.infer<typeof LiveBlockSchema>

/** A call has ended once its status is one of these; providers spell them differently. */
export function liveToolFinished(status: string): boolean {
  return status === "failed" || /cancel|complete|done/i.test(status)
}

/** A block that opens a turn: the user's prompt, or the cause of one the provider started itself. */
export function isTurnStart(block: LiveBlock | undefined): boolean {
  return (block?.type === "user" && !block.steeringFor) || block?.type === "provider-turn"
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
    const merged: LiveUpdate = {
      ...previous,
      title: next.title ?? previous.title,
      status: next.status ?? previous.status,
      input: next.input ?? previous.input,
      output: next.output ?? previous.output,
      details: next.details ?? previous.details,
      attachments: next.attachments ?? previous.attachments,
    }
    if (next.unfinished) merged.unfinished = true
    return merged
  }
  return undefined
}

/** The host and renderer use the same pure projection. One allocation per delivered batch. */
export function reduceLiveUpdates(
  blocks: LiveBlock[],
  updates: LiveUpdate[]
): LiveBlock[] {
  if (!updates.length) return blocks
  const next = [...blocks]
  let from = blocks.length
  const replace = (index: number, block: LiveBlock) => {
    const at = index < 0 ? next.length : index
    from = Math.min(from, at)
    next[at] = block
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
  for (const update of updates) {
    const last = next.at(-1)
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
          input: update.input ?? block.input,
          output: update.output ?? block.output,
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
        if (update.setup && next.some((candidate) => candidate.type === "event" && sameSetupEvent(candidate, update)))
          break
        const block: LiveBlock = { type: "event", label: update.label, detail: update.detail, body: update.body, tone: update.tone }
        if (update.setup) block.setup = true
        if (update.id) block.id = update.id
        replace(update.id ? findCurrent((candidate) => candidate.type === "event" && candidate.id === update.id) : -1, block)
        break
      }
      case "retract": {
        const ids = new Set(update.ids)
        let kept = turnStart + 1
        for (let index = turnStart + 1; index < next.length; index++) {
          const block = next[index]!
          const withdrawn = (block.type === "text" || block.type === "thinking" || block.type === "tool") && block.id !== undefined && ids.has(block.id)
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
