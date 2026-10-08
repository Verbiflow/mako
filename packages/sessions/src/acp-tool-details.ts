import { z } from "zod"
import { attachmentFromUrl, ToolDetailSchema, type AttachmentContent, type ToolDetail } from "./content.js"

/** An ACP value as JSON carries it: tool content, raw output, a history line's field. */
export type AcpContentValue =
  | string
  | number
  | boolean
  | null
  | AcpContentValue[]
  | { [key: string]: AcpContentValue | undefined }

const acpDetail = z.union([
  ToolDetailSchema,
  z
    .object({
      type: z.literal("diff"),
      path: z.string(),
      oldText: z.string().nullish(),
      newText: z.string(),
    })
    .transform((diff) => ({ ...diff, oldText: diff.oldText ?? null })),
])

/** ACP's `locations`: the files a tool call works on. */
export const AcpLocationsSchema = z.array(z.object({ path: z.string(), line: z.number().nullish() }))
export type AcpLocation = z.infer<typeof AcpLocationsSchema>[number]

/** The files a tool call works on, as links after its content. */
export function acpLocationDetails(locations: readonly AcpLocation[] | null | undefined): ToolDetail[] {
  return (locations ?? []).map((location) => ({
    type: "location",
    path: location.path,
    line: location.line ?? undefined,
  }))
}

/** Native ACP journals carry the same structured tool content as live updates. */
export function acpToolDetails(
  content: AcpContentValue | undefined
): ToolDetail[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((part) => {
    const parsed = acpDetail.safeParse(part)
    return parsed.success ? [parsed.data] : []
  })
}

const TEXT_KEYS = ["content", "output_for_prompt", "output", "result", "message", "error"]
/**
 * The words in an ACP value: a string as it is, content parts joined, or the
 * first text under a key agents put output in. A structured tool result with
 * no such text (an edit's report, a todo list's state) has none; its content
 * or the vendor's decoder says what it did.
 */
export function acpText(value: AcpContentValue | undefined): string {
  return wordsIn(value)
}

function wordsIn(value: AcpContentValue | undefined): string {
  if (isWords(value)) return value
  if (Array.isArray(value)) return value.map(wordsIn).join("")
  if (!isFields(value)) return ""
  const text = value["text"]
  if (isWords(text)) return text
  for (const key of TEXT_KEYS) {
    const nested = wordsIn(value[key])
    if (nested) return nested
  }
  return ""
}

function isWords(value: AcpContentValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

function isFields(value: AcpContentValue | undefined): value is { [key: string]: AcpContentValue | undefined } {
  return Object.prototype.toString.call(value) === "[object Object]"
}

/* --------------------------------------------------- one tool, one reading */

const ResourceSchema = z.object({ uri: z.string(), mimeType: z.string().nullish(), text: z.string().optional(), blob: z.string().optional() })

/** ACP's `ContentBlock`, as a message chunk or a tool's content carries it. */
export const AcpContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), data: z.string().nullish(), mimeType: z.string().nullish(), uri: z.string().nullish() }),
  z.object({ type: z.literal("audio"), data: z.string().nullish(), mimeType: z.string().nullish() }),
  z.object({ type: z.literal("resource_link"), uri: z.string(), name: z.string(), title: z.string().nullish(), mimeType: z.string().nullish() }),
  z.object({ type: z.literal("resource"), resource: ResourceSchema }),
])
export type AcpContentBlock = z.infer<typeof AcpContentBlockSchema>

/** One part of a tool call's `content`. */
export const AcpToolContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("content"), content: AcpContentBlockSchema }),
  z.object({ type: z.literal("diff"), path: z.string(), oldText: z.string().nullish(), newText: z.string() }),
  z.object({ type: z.literal("terminal"), terminalId: z.string() }),
])
export type AcpToolContent = z.infer<typeof AcpToolContentSchema>

/** A `tool_call` or `tool_call_update` as ACP carries it, live or in a store that kept the wire. */
export const AcpToolUpdateSchema = z.object({
  title: z.string().nullish().catch(undefined),
  kind: z.string().nullish().catch(undefined),
  status: z.string().nullish().catch(undefined),
  content: z.array(z.json()).nullish().catch(undefined),
  locations: AcpLocationsSchema.nullish().catch(undefined),
  rawInput: z.json().optional().catch(undefined),
  rawOutput: z.json().optional().catch(undefined),
  _meta: z.record(z.string(), z.json()).nullish().catch(undefined),
})
export type AcpToolUpdate = z.infer<typeof AcpToolUpdateSchema>

/** ACP's terminal extension: how a call's shell exited, in `_meta.terminal_exit`. */
const TerminalExitSchema = z.object({ exit_code: z.number().nullish() })

/** What a harness's tool updates mean beyond ACP's own fields. */
export interface AcpToolReading {
  /** Content the agent sends for its own client's display, which repeats the call and is left out. */
  omits?(part: AcpToolContent): boolean
  /** The status an update means when its own says less, as a call the person stopped reported only `failed`. */
  status?(update: AcpToolUpdate): string | undefined
  /** The input the harness keeps for a call whose `rawInput` repeats its own content; `undefined` keeps `rawInput`. */
  input?(update: AcpToolUpdate): AcpContentValue | undefined
}

/** The fields of a tool row that one update carries; an update replaces the fields it carries and keeps the rest. */
export interface AcpToolFields {
  title?: string
  kind?: string
  status?: string
  input?: string
  output?: string
  /** What `content` shows besides text: diffs and terminals. */
  details?: ToolDetail[]
  /** `locations`, as links; ACP replaces them apart from `content`. */
  locations?: ToolDetail[]
  attachments?: AttachmentContent[]
  /** How the call's shell exited, from ACP's terminal extension. */
  exitCode?: number
}

/**
 * One ACP tool update read the way every reader of ACP reads it: the live
 * decoder and the history readers of the harnesses whose stores keep the
 * wire. Text parts are the output, or the agent's words in `rawOutput`
 * when there are none; diffs and terminals are details, and `locations`
 * links; media and resources are attachments. A tool shows its details
 * and links as one list (`acpShownDetails`).
 */
export function acpToolFields(update: AcpToolUpdate, reading: AcpToolReading = {}): AcpToolFields {
  const text: string[] = []
  const details: ToolDetail[] = []
  const attachments: AttachmentContent[] = []
  for (const value of update.content ?? []) {
    const parsed = AcpToolContentSchema.safeParse(value)
    if (!parsed.success || reading.omits?.(parsed.data)) continue
    const part = parsed.data
    if (part.type === "diff") details.push({ type: "diff", path: part.path, oldText: part.oldText ?? null, newText: part.newText })
    else if (part.type === "terminal") details.push({ type: "terminal", terminalId: part.terminalId })
    else if (part.content.type === "text") text.push(part.content.text)
    else attachments.push(acpAttachment(part.content))
  }
  const fields: AcpToolFields = {}
  if (update.title) fields.title = update.title
  if (update.kind) fields.kind = update.kind
  const status = reading.status?.(update) ?? update.status
  if (status) fields.status = status
  const input = reading.input?.(update) ?? update.rawInput
  if (input !== undefined) fields.input = JSON.stringify(input, null, 2)
  // An empty text part says nothing; the agent's own words for the result (Grok's `output_for_prompt`) do.
  const output = text.join("\n") || acpText(update.rawOutput) || (text.length ? "" : undefined)
  if (output !== undefined) fields.output = output
  if (details.length) fields.details = details
  if (update.locations) fields.locations = acpLocationDetails(update.locations)
  if (attachments.length) fields.attachments = attachments
  const exit = TerminalExitSchema.safeParse(update._meta?.["terminal_exit"])
  if (exit.success && exit.data.exit_code != null) fields.exitCode = exit.data.exit_code
  return fields
}

/** `update` over `tool`, as the live reducer applies a `tool_call_update`. */
export function mergeAcpTool(tool: AcpToolFields, update: AcpToolFields): AcpToolFields {
  const merged = { ...tool }
  if (update.title !== undefined) merged.title = update.title
  if (update.kind !== undefined) merged.kind = update.kind
  if (update.status !== undefined) merged.status = update.status
  if (update.input !== undefined) merged.input = update.input
  if (update.output !== undefined) merged.output = update.output
  if (update.details !== undefined) merged.details = update.details
  if (update.locations !== undefined) merged.locations = update.locations
  if (update.attachments !== undefined) merged.attachments = update.attachments
  if (update.exitCode !== undefined) merged.exitCode = update.exitCode
  return merged
}

/** The details a tool shows: its content's, then its links; `undefined` when it has neither. */
export function acpShownDetails(fields: AcpToolFields): ToolDetail[] | undefined {
  return fields.details === undefined && fields.locations === undefined
    ? undefined
    : [...fields.details ?? [], ...fields.locations ?? []]
}

/**
 * What a tool call's updates mean together, which no single one says:
 * - A tool shows its details and links as one list while ACP replaces them
 *   apart, so an update that carries one keeps the other: Devin and Grok
 *   resend a read's or an edit's content without its `locations`.
 * - A shell that exited non-zero failed, though the update that ends its
 *   call can say `completed` and come after the one carrying the exit code:
 *   Devin 3000.10.23 does both for `cat` of a missing file.
 * - A stopped call stays stopped: Devin follows its cancel with the killed
 *   command's `completed`, exit code -1.
 * An ended call is forgotten, but for having been stopped.
 */
export class AcpToolCalls {
  private readonly running = new Map<string, Pick<AcpToolFields, "details" | "locations" | "exitCode">>()
  private readonly stopped = new Set<string>()
  private readonly answered = new Set<string>()

  /** Call `id` already showed a result or ended, so a later update has nothing to add to what it showed. */
  hasAnswered(id: string): boolean {
    return this.answered.has(id)
  }

  /**
   * Call `id` as `update` leaves it: `details` the whole list when the update
   * changes it, and `status` what the call's updates so far mean, when the
   * update changes that.
   */
  read(id: string, update: AcpToolFields): Pick<AcpToolFields, "details" | "status"> {
    const merged = mergeAcpTool(this.running.get(id) ?? {}, update)
    const status = this.stopped.has(id)
      ? undefined
      : update.status === "completed" && merged.exitCode !== undefined && merged.exitCode !== 0
        ? "failed"
        : update.status
    if (status !== undefined && /cancel/i.test(status)) this.stopped.add(id)
    if (update.output !== undefined || status === "completed" || status === "failed" || this.stopped.has(id)) this.answered.add(id)
    if (status === "completed" || status === "failed" || this.stopped.has(id)) this.running.delete(id)
    else this.running.set(id, { details: merged.details, locations: merged.locations, exitCode: merged.exitCode })
    const details = update.details === undefined && update.locations === undefined ? undefined : acpShownDetails(merged)
    return { details, status }
  }
}

/** A media or resource content block as an attachment. An embedded resource is inlined, since it carries its own contents. */
export function acpAttachment(block: Exclude<AcpContentBlock, { type: "text" }>): AttachmentContent {
  switch (block.type) {
    case "image":
    case "audio": {
      const mimeType = block.mimeType ?? (block.type === "image" ? "image/png" : "audio/wav")
      if (block.data) return { type: "attachment", name: block.type, mimeType, source: { kind: "inline", data: block.data } }
      if (block.type === "image" && block.uri) return attachmentFromUrl(block.type, mimeType, block.uri)
      return { type: "attachment", name: block.type, mimeType, source: { kind: "unavailable", reason: "The provider did not retain the attachment bytes" } }
    }
    case "resource_link":
      return attachmentFromUrl(block.title ?? block.name, block.mimeType ?? "application/octet-stream", block.uri)
    case "resource": {
      const { resource } = block
      const data = resource.blob ?? (resource.text === undefined ? undefined : Buffer.from(resource.text).toString("base64"))
      const mimeType = resource.mimeType ?? "application/octet-stream"
      if (data === undefined) return attachmentFromUrl(resource.uri, mimeType, resource.uri)
      return { type: "attachment", name: resource.uri, mimeType, source: { kind: "inline", data } }
    }
  }
}

/** The attachments in a message chunk's content block, or in a tool's content parts. */
export function acpAttachments(value: AcpContentValue | undefined): AttachmentContent[] {
  if (Array.isArray(value)) return value.flatMap(acpAttachments)
  const part = AcpToolContentSchema.safeParse(value)
  if (part.success) return part.data.type === "content" && part.data.content.type !== "text" ? [acpAttachment(part.data.content)] : []
  const block = AcpContentBlockSchema.safeParse(value)
  return block.success && block.data.type !== "text" ? [acpAttachment(block.data)] : []
}
