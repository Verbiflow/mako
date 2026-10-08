import type { SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk"
import { z } from "zod"
import { AcpToolCalls, acpAttachment, acpShownDetails, acpToolFields, AcpToolUpdateSchema, type AcpToolFields, type AcpToolReading } from "./acp-tool-details.js"
import { agentTitleFrom } from "./format.js"
import type { LiveUpdate } from "./live-content.js"
import { normalizeAcpOptions, type AcpConfigOptionInput } from "./model-catalog.js"
import type { ModelOption, SessionSettings } from "./settings.js"

const RawSchema = z.json().catch(null)
type Raw = z.infer<typeof RawSchema>

/** What an update says about the session: its mode, options, settings or title. */
export interface AcpSessionPatch {
  currentMode?: string
  configOptions?: ModelOption[]
  settings?: SessionSettings
  title?: string
}

/**
 * One ACP update in the vocabulary every harness shares: content, session
 * state, or a kind with no meaning here, kept with its record. Mako's live
 * client folds these into the desk's `Decoded`; a store that kept the wire
 * folds the content into saved history.
 */
export type AcpDecoded =
  | { kind: "update"; update: LiveUpdate }
  | { kind: "state"; patch: AcpSessionPatch }
  | { kind: "unknown"; type: string; reason: "unknown"; raw: Raw }

const content = (update: LiveUpdate): AcpDecoded => ({ kind: "update", update })
const state = (patch: AcpSessionPatch): AcpDecoded => ({ kind: "state", patch })
const unknown = (type: string, raw: Raw): AcpDecoded => ({ kind: "unknown", type, reason: "unknown", raw })

export type AcpToolCallUpdate = Extract<SessionUpdate, { sessionUpdate: "tool_call" }>
export type AcpToolCallChange = Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>
export type AcpUserChunk = Extract<SessionUpdate, { sessionUpdate: "user_message_chunk" }>

/** The plan handover a harness layers on ACP's updates, opened once per session. Pure. */
export interface AcpPlanDecoder {
  update(update: SessionUpdate, sessionId: string): LiveUpdate[]
}

/**
 * What a harness's updates mean beyond ACP's own fields. Each is pure, and
 * the same hooks read the live wire and a store that saved it.
 */
export interface AcpDecoderHooks<Plans extends AcpPlanDecoder = AcpPlanDecoder> {
  /** Native tool identity supplied by provider extensions to ACP metadata. */
  toolName?(tool: AcpToolCallUpdate): string | undefined
  /** A tool the agent reports `completed` that Mako shows failed, as a shell command that exited non-zero. */
  toolFailed?(update: AcpToolCallChange): boolean
  /** What the agent's tool updates mean beyond ACP's own fields. */
  toolReading?: AcpToolReading
  /** An update the agent sends only to redraw its own display and never keeps in its store; Mako leaves it out, so a session reads the same reopened. */
  transient?(notification: SessionNotification): boolean
  /**
   * A user message the agent replays on `session/load`, as its store reader
   * reads the same record: a turn the agent started itself, a command whose
   * effect is already drawn (`null`), or a steer's typed text. `undefined`
   * keeps it the person's message as sent.
   */
  replayedUser?(update: AcpUserChunk): LiveUpdate | null | undefined
  /**
   * An update the agent sends in another shape than it did live, on
   * `session/load` or in a store that saved that replay, restated as the one
   * it sent live; `null` for one that adds nothing once restated. `calls`
   * says which calls already showed a result.
   */
  restated?(update: SessionUpdate, calls: Pick<AcpToolCalls, "hasAnswered">): SessionUpdate | null | undefined
  /**
   * The agent's plan handover: proposed plans from its updates, and on the
   * live side the request whose approval builds one. Opened once per
   * session, since a harness may number a plan's revisions.
   */
  plans?(): Plans
}

/** The settings a config option list reports as chosen; `model` is kept when the list names none. */
export function acpObservedSettings(options: AcpConfigOptionInput[], model?: string): SessionSettings {
  const settings: SessionSettings = { model, options: {} }
  for (const option of normalizeAcpOptions(options)) {
    if (option.current === undefined) continue
    if (option.id === "model" && option.kind === "select") settings.model = option.current
    else settings.options![option.id] = option.current
  }
  return settings
}

/** What an update needs beyond itself: the session's settings and the harness's reading of a tool. */
export interface AcpUpdateContext {
  settings?: SessionSettings
  toolName?: string
  /** The harness counts this finished tool as failed though its status does not say so. */
  toolFailed?: boolean
  toolReading?: AcpToolReading
  /** The session's running tools, so an update keeps the details or links it doesn't resend; without it an update shows only its own. */
  tools?: AcpToolCalls
}

/**
 * One ACP session update in the shared vocabulary. Pure, like every
 * decoder. Usage and the command list are the host's to read, so they
 * decode to nothing here; an unknown kind is reported as its own kind.
 */
export function decodeAcpUpdate(raw: SessionUpdate, context: AcpUpdateContext = {}): AcpDecoded[] {
  let update: LiveUpdate
  switch (raw.sessionUpdate) {
    case "user_message_chunk":
      // Replayed history (session/load streams the past back). Live user
      // turns are emitted by livePrompt itself and never arrive this way.
      update = raw.content.type === "text"
        ? { kind: "user", text: raw.content.text }
        : { kind: "user", text: "", attachments: [acpAttachment(raw.content)] }
      if (raw.messageId) update.messageId = raw.messageId
      break
    case "agent_message_chunk":
      update = raw.content.type === "text"
        ? { kind: "text", text: raw.content.text }
        : { kind: "attachment", attachment: acpAttachment(raw.content) }
      break
    case "agent_thought_chunk":
      update = raw.content.type === "text"
        ? { kind: "thinking", text: raw.content.text }
        : { kind: "attachment", attachment: acpAttachment(raw.content) }
      break
    case "tool_call": {
      const fields = acpToolFields(AcpToolUpdateSchema.parse(raw), context.toolReading)
      const { details, status } = context.tools ? context.tools.read(raw.toolCallId, fields) : shownAlone(fields)
      update = {
        kind: "tool",
        id: raw.toolCallId,
        title: fields.title ?? "tool",
        name: context.toolName,
        toolKind: raw.kind,
        status: status ?? "pending",
        input: fields.input,
        output: fields.output,
        details,
        attachments: fields.attachments,
      }
      break
    }
    case "tool_call_update": {
      const fields = acpToolFields(AcpToolUpdateSchema.parse(raw), context.toolReading)
      const { details, status } = context.tools ? context.tools.read(raw.toolCallId, fields) : shownAlone(fields)
      update = {
        kind: "tool-update",
        id: raw.toolCallId,
        title: fields.title,
        status: context.toolFailed ? "failed" : status,
        input: fields.input,
        output: fields.output,
        details,
        attachments: fields.attachments,
      }
      break
    }
    case "plan":
      update = { kind: "plan", entries: (raw.entries ?? []).map((entry) => ({ content: entry.content, status: entry.status })) }
      break
    case "current_mode_update":
      return [state({ currentMode: raw.currentModeId })]
    case "config_option_update":
      return [state({
        configOptions: normalizeAcpOptions(raw.configOptions),
        settings: acpObservedSettings(raw.configOptions, context.settings?.model),
      })]
    case "session_info_update": {
      // A cleared title keeps the one the thread has; `updatedAt` is the agent's own bookkeeping.
      const title = agentTitleFrom(raw.title ?? undefined)
      return title ? [state({ title })] : []
    }
    // The host reads these before forwarding: the context reading and the command list.
    case "usage_update":
    case "available_commands_update":
      return []
    default:
      return [unknown(raw.sessionUpdate, null)]
  }
  return (update.kind !== "text" && update.kind !== "user") || update.text || (update.kind === "user" && update.attachments?.length)
    ? [content(update)]
    : []
}

/** An update read without its call's earlier ones: only what it carries. */
function shownAlone(fields: AcpToolFields): Pick<AcpToolFields, "details" | "status"> {
  return { details: acpShownDetails(fields), status: fields.status }
}

/**
 * One ACP session's updates in the shared vocabulary: the protocol's own,
 * read through the harness's hooks, and the harness's plan handover layered
 * on them. Pure apart from its running tools and the plan decoder's own
 * state, so the live client, the fixture runner (`npm run test:decoders`)
 * and a store that saved the wire decode the same updates the same way.
 */
export class AcpUpdateDecoder<Plans extends AcpPlanDecoder = AcpPlanDecoder> {
  protected readonly plans: Plans | undefined
  private readonly tools = new AcpToolCalls()
  private readonly hooks: AcpDecoderHooks<Plans> | undefined
  private readonly settings: () => SessionSettings | undefined

  constructor(hooks: AcpDecoderHooks<Plans> | undefined, settings: () => SessionSettings | undefined = () => undefined) {
    this.hooks = hooks
    this.settings = settings
    this.plans = hooks?.plans?.()
  }

  /** A `session/update`. An unknown kind is `session/update/<kind>`, with the notification kept. */
  update(notification: SessionNotification): AcpDecoded[] {
    if (this.hooks?.transient?.(notification)) return []
    const restated = this.hooks?.restated?.(notification.update, this.tools)
    if (restated === null) return []
    const update = restated ?? notification.update
    if (update.sessionUpdate === "user_message_chunk") {
      const read = this.hooks?.replayedUser?.(update)
      if (read === null) return []
      if (read) return [content(read)]
    }
    const toolName = update.sessionUpdate === "tool_call" ? this.hooks?.toolName?.(update) : undefined
    const toolFailed = update.sessionUpdate === "tool_call_update" && update.status === "completed" && this.hooks?.toolFailed?.(update)
    const out = decodeAcpUpdate(update, { settings: this.settings(), toolName, toolFailed, toolReading: this.hooks?.toolReading, tools: this.tools }).map((item) =>
      item.kind === "unknown" ? unknown(`session/update/${item.type}`, RawSchema.parse(notification)) : item)
    for (const plan of this.plans?.update(update, notification.sessionId) ?? []) out.push(content(plan))
    return out
  }
}
