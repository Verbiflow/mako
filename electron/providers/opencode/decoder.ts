import type { OpenCodeEvent } from "@opencode/client"
import { isOpenCodeInstruction, openCodeNoticeLabel, openCodeTurnFailed } from "@mako/sessions"
import { openCodeTokens } from "@mako/sessions/harnesses"
import { z } from "zod"
import type { AccessTier } from "../../contracts/access.js"
import type { Decoded } from "../../contracts/native-decoding.js"
import { SessionUsage, type UsageObservation } from "../../session-usage.js"
import { openCodeModeForAgent } from "./access.js"
import type { OpenCodeAgents } from "./agents.js"
import { OpenCodeShells } from "./background.js"
import type { OpenCodeModelRef } from "./catalog.js"
import { OpenCodeContent } from "@mako/sessions/opencode-content"
import { openCodeEventUpdates } from "./content.js"
import { openCodeIgnores } from "./notices.js"
import { OPENCODE_REQUESTS, openCodeRequest, openCodeRequestSession, type OpenCodeRequest } from "./requests.js"

/** OpenCode's own error on a failed execution or compaction. */
export interface OpenCodeError { type: string; message: string }

/** A notice OpenCode enqueued for itself, which may start a turn of its own. */
export interface OpenCodeNotice {
  /** The shell or subagent session whose end it reports. */
  ended?: string
  /** What a turn started on it shows as its cause; none for an instruction to the model. */
  cause?: string
}

/**
 * What the root session's inbox and execution said. The driver binds each to
 * the turn it sent, or to one OpenCode started on a notice; `source` is the
 * native event a marker drawn from it cites.
 */
export type OpenCodeTurnFact =
  | { type: "enqueued"; inbox: string; item: InboxItem["type"]; notice?: OpenCodeNotice }
  | { type: "delivered"; inbox: string }
  /** Withdrawn before OpenCode delivered it. */
  | { type: "cancelled"; inbox: string }
  | { type: "started" }
  | { type: "succeeded" }
  | { type: "failed"; error: OpenCodeError }
  | { type: "interrupted"; reason: InterruptReason; source: string }
  | { type: "compaction-failed"; inbox?: string; error: OpenCodeError; source: string }

/** OpenCode's facts the driver acts on beyond the transcript. */
export type OpenCodeEffect =
  | { type: "turn"; turn: OpenCodeTurnFact }
  /** A subagent session stopped executing; Stop waits for each it interrupted. */
  | { type: "child-settled"; sessionID: string }
  /** A request of a session this conversation owns, kept in the driver's request store. */
  | { type: "request"; request: OpenCodeRequest }
  /** One of the lists the catalog holds changed for this directory; the driver reloads the catalog. */
  | { type: "catalog"; changed: "models" | "agents" | "commands" | "skills" }
  /** The event names only the server, so the driver reads its state back. */
  | { type: "mcp"; server: string }
  | { type: "model"; model: OpenCodeModelRef }
  /** A root tool call, for the subagent observer. */
  | { type: "agent-call"; call: Parameters<OpenCodeAgents["observe"]>[0] }

type InboxItem = Extract<OpenCodeEvent, { type: "session.inbox.enqueued" }>["data"]["item"]
type InterruptReason = Extract<OpenCodeEvent, { type: "session.execution.interrupted" }>["data"]["reason"]

/** A notice's metadata: what ended (a shell, or a subagent's session), and how. */
const NoticeMetadata = z.object({
  source: z.string().optional(),
  state: z.string().optional(),
  shellID: z.string().optional(),
  childID: z.string().optional(),
})

function openCodeNotice(item: InboxItem): OpenCodeNotice | undefined {
  if (item.type !== "synthetic") return undefined
  const notice = item.payload
  const metadata = NoticeMetadata.safeParse(notice.metadata ?? {}).data ?? {}
  const read = { text: notice.text, description: notice.description, source: metadata.source, state: metadata.state }
  const ended = metadata.shellID ?? metadata.childID
  const cause = isOpenCodeInstruction(read) ? undefined : openCodeNoticeLabel(read)
  if (!ended && !cause) return undefined
  const decoded: OpenCodeNotice = {}
  if (ended) decoded.ended = ended
  if (cause) decoded.cause = cause
  return decoded
}

const CATALOG_LISTS = {
  "catalog.updated": "models",
  "agent.updated": "agents",
  "command.updated": "commands",
  "skill.updated": "skills",
} as const satisfies Record<string, Extract<OpenCodeEffect, { type: "catalog" }>["changed"]>

/** What the decoder reads from the live session. */
export interface OpenCodeDecoderView {
  readonly launchAccess: AccessTier
  /** The selected model's context window, once the catalog names it. */
  contextSize(): number | undefined
}

const TURN = new Set<string>([
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.compaction.failed",
])
const REQUESTS = OPENCODE_REQUESTS
const CATALOG = new Set<string>(Object.keys(CATALOG_LISTS))
/** Root session state; never transcript content. */
const SESSION_STATE = new Set<string>([
  "session.created",
  "session.renamed",
  "session.usage.updated",
  "session.agent.selected",
  "session.model.selected",
  "session.retry.scheduled",
  "session.compaction.started",
  "session.compaction.delta",
  "session.compaction.ended",
])
/** Content kinds the projection knows and shows nothing for. */
export const OPENCODE_QUIET_CONTENT = new Set<string>([
  "session.text.started",
  "session.reasoning.started",
  "session.reasoning.ended",
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.step.streamed",
  "session.step.failed",
  "session.status",
  "session.idle",
])
export const OPENCODE_DECODED = new Set<string>([
  ...TURN, ...REQUESTS, ...CATALOG, ...SESSION_STATE,
  "mcp.status.changed",
  "shell.created",
  "shell.exited",
  "shell.deleted",
  "session.text.delta",
  "session.reasoning.delta",
  "session.tool.input.started",
  "session.tool.called",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
  "session.step.started",
  "session.text.ended",
  "session.step.ended",
  "session.revert.committed",
])

const SessionScope = z.object({ sessionID: z.string() })

/** The stored message OpenCode projects from an event that names none: the event's id under the message prefix. */
function projectedMessage(eventID: string): string {
  return eventID.replace(/^evt_/, "msg_")
}

/** The catalog list an event changed for `cwd`; it arrives before the session exists too. */
export function openCodeCatalogChange(event: OpenCodeEvent, cwd: string): Extract<OpenCodeEffect, { type: "catalog" }>["changed"] | undefined {
  if (event.type !== "catalog.updated" && event.type !== "agent.updated" && event.type !== "command.updated" && event.type !== "skill.updated") return undefined
  return !event.location || event.location.directory === cwd ? CATALOG_LISTS[event.type] : undefined
}

/**
 * One conversation's OpenCode event stream as Mako's decoded events. The
 * driver binds turns and requests and decides when transcript content may
 * apply; this owns what the events say about the root session and its
 * subagent sessions.
 */
export class OpenCodeDecoder {
  readonly content: OpenCodeContent
  readonly shells: OpenCodeShells
  /** Subagent sessions the root started, by native session id. */
  readonly children = new Set<string>()
  private readonly meter = new SessionUsage()
  /** The root's current reply: the stored message a failed or stopped turn is recorded on. */
  private reply: string | undefined
  /** The running compaction's stored message. */
  private compaction: string | undefined
  /** The stored message each compaction's end named, by the ending event: a replayed end names the same one. */
  private readonly compactions = new Map<string, string>()
  readonly root: string
  private readonly cwd: string
  private readonly view: OpenCodeDecoderView

  constructor(root: string, cwd: string, view: OpenCodeDecoderView) {
    this.root = root
    this.cwd = cwd
    this.view = view
    this.content = new OpenCodeContent(root, cwd)
    this.shells = new OpenCodeShells((sessionID) => this.owns(sessionID))
  }

  owns(sessionID: string): boolean {
    return sessionID === this.root || this.children.has(sessionID)
  }

  /** Transcript content of a session this conversation owns: it applies in stream order behind any missed call's name. */
  transcript(event: OpenCodeEvent): boolean {
    if (CATALOG.has(event.type) || REQUESTS.has(event.type) || TURN.has(event.type) || SESSION_STATE.has(event.type)
      || event.type === "mcp.status.changed" || openCodeIgnores(event)) return false
    const scope = SessionScope.safeParse(event.data).data
    return scope !== undefined && this.owns(scope.sessionID)
  }

  /** The usage reading after these observations, measured against the current model's window. */
  usage(...observations: UsageObservation[]): Decoded<OpenCodeEffect>[] {
    const size = this.view.contextSize()
    const usage = this.meter.observe(...observations, ...size ? [{ kind: "window" as const, size }] : [])
    return usage ? [{ kind: "state", patch: { usage } }] : []
  }

  decode(event: OpenCodeEvent): Decoded<OpenCodeEffect>[] {
    const decoded: Decoded<OpenCodeEffect>[] = []
    const background = this.shells.observe(event)
    if (background !== undefined) decoded.push({ kind: "state", patch: { backgroundTasks: background } })
    if (CATALOG.has(event.type)) {
      const changed = openCodeCatalogChange(event, this.cwd)
      if (changed) decoded.push({ kind: "effect", effect: { type: "catalog", changed } })
      return decoded
    }
    if (REQUESTS.has(event.type)) {
      const request = openCodeRequest(event)
      if (!request) return [...decoded, { kind: "unknown", type: event.type, reason: "unreadable", raw: z.json().parse(event) }]
      return this.owns(openCodeRequestSession(request)) ? [...decoded, { kind: "effect", effect: { type: "request", request } }] : decoded
    }
    if (event.type === "mcp.status.changed") {
      if (!event.location || event.location.directory === this.cwd) decoded.push({ kind: "effect", effect: { type: "mcp", server: event.data.server } })
      return decoded
    }
    if (event.type === "session.step.started" && event.data.sessionID === this.root) this.reply = event.data.assistantMessageID
    if (TURN.has(event.type)) return [...decoded, ...this.turn(event)]
    if (SESSION_STATE.has(event.type)) return [...decoded, ...this.session(event)]
    // OpenCode deleted the messages from `to` on, whichever client reverted.
    if (event.type === "session.revert.committed")
      return event.data.sessionID === this.root ? [...decoded, { kind: "rewound", run: event.data.to }] : decoded
    if (openCodeIgnores(event)) return decoded
    const scope = SessionScope.safeParse(event.data).data
    if (!scope) return [...decoded, { kind: "unknown", type: event.type, reason: "unknown", raw: z.json().parse(event) }]
    if (!this.owns(scope.sessionID)) return decoded
    return [...decoded, ...this.contentOf(event)]
  }

  private turn(event: OpenCodeEvent): Decoded<OpenCodeEffect>[] {
    const decoded: Decoded<OpenCodeEffect>[] = []
    if (event.type === "session.execution.started" && event.data.sessionID === this.root) this.reply = undefined
    if ((event.type === "session.execution.failed" || event.type === "session.execution.interrupted") && this.children.has(event.data.sessionID))
      for (const update of this.content.settle(event.data.sessionID, event.type === "session.execution.failed" ? "failed" : "cancelled", "The subagent stopped before this call finished."))
        decoded.push({ kind: "update", update })
    if (event.type === "session.compaction.failed" && event.data.sessionID === this.root) decoded.push({ kind: "activity", activity: null })
    // A stopped turn reads as interrupted, from the driver, which knows whether the person stopped it.
    if (event.type === "session.execution.failed" && event.data.sessionID === this.root && event.data.error.type !== "aborted")
      decoded.push({ kind: "marker", marker: openCodeTurnFailed(event.data.error.type, event.data.error.message), source: this.reply ?? event.id })
    const effect = this.turnEffect(event)
    if (effect) decoded.push({ kind: "effect", effect })
    return decoded
  }

  private turnEffect(event: OpenCodeEvent): OpenCodeEffect | undefined {
    if (!("sessionID" in event.data)) return undefined
    const sessionID = event.data.sessionID
    if (sessionID !== this.root) {
      const ends = event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted"
      return ends && this.children.has(sessionID) ? { type: "child-settled", sessionID } : undefined
    }
    const turn = (fact: OpenCodeTurnFact): OpenCodeEffect => ({ type: "turn", turn: fact })
    switch (event.type) {
      case "session.inbox.enqueued": {
        const enqueued: Extract<OpenCodeTurnFact, { type: "enqueued" }> = { type: "enqueued", inbox: event.data.inboxID, item: event.data.item.type }
        const notice = openCodeNotice(event.data.item)
        if (notice) enqueued.notice = notice
        return turn(enqueued)
      }
      case "session.inbox.delivered":
        return turn({ type: "delivered", inbox: event.data.inboxID })
      case "session.inbox.cancelled":
        return turn({ type: "cancelled", inbox: event.data.inboxID })
      case "session.execution.started":
        return turn({ type: "started" })
      case "session.execution.succeeded":
        return turn({ type: "succeeded" })
      case "session.execution.failed":
        return turn({ type: "failed", error: { type: event.data.error.type, message: event.data.error.message } })
      case "session.execution.interrupted":
        return turn({ type: "interrupted", reason: event.data.reason, source: this.reply ?? event.id })
      case "session.compaction.failed": {
        const failed: Extract<OpenCodeTurnFact, { type: "compaction-failed" }> = {
          type: "compaction-failed",
          error: { type: event.data.error.type, message: event.data.error.message },
          source: this.compactionEnded(event.id, event.data.inputID),
        }
        if (event.data.inputID) failed.inbox = event.data.inputID
        return turn(failed)
      }
      default:
        return undefined
    }
  }

  private session(event: OpenCodeEvent): Decoded<OpenCodeEffect>[] {
    switch (event.type) {
      case "session.created":
        if (event.data.parentID && this.owns(event.data.parentID)) {
          this.children.add(event.data.sessionID)
          this.content.nameSession(event.data.sessionID, event.data.title)
        }
        return []
      case "session.renamed":
        if (event.data.sessionID === this.root) return [{ kind: "state", patch: { title: event.data.title } }]
        if (this.children.has(event.data.sessionID)) this.content.nameSession(event.data.sessionID, event.data.title)
        return []
      default:
        break
    }
    if (!("sessionID" in event.data) || event.data.sessionID !== this.root) return []
    switch (event.type) {
      case "session.usage.updated":
        // The session's total across every OpenCode process; each step's own spend is counted when it ends.
        return []
      case "session.agent.selected":
        return [{ kind: "state", patch: { currentMode: openCodeModeForAgent(event.data.agent, this.view.launchAccess) } }]
      case "session.model.selected":
        return [{ kind: "effect", effect: { type: "model", model: event.data.model } }]
      case "session.retry.scheduled":
        // OpenCode's `at` is epoch ms on this host's clock.
        return [{ kind: "activity", activity: { kind: "retrying", attempt: event.data.attempt, reason: event.data.error.message, retryAt: event.data.at } }]
      case "session.compaction.started":
        this.compaction = event.data.inputID ?? projectedMessage(event.id)
        return [{ kind: "activity", activity: { kind: "compacting" } }]
      case "session.compaction.ended": {
        const source = this.compactionEnded(event.id)
        return [{
          kind: "compacted",
          compaction: { trigger: event.data.reason === "auto" ? "automatic" : "manual", tokensBefore: this.meter.context, summary: event.data.text },
          source,
        }, ...this.usage({ kind: "compacted" })]
      }
      default:
        return []
    }
  }

  /** The stored message a compaction's end settles, as OpenCode projects it: the running one, else its input, else the end itself. */
  private compactionEnded(eventID: string, inputID?: string): string {
    const known = this.compactions.get(eventID)
    if (known) return known
    const record = this.compaction ?? inputID ?? projectedMessage(eventID)
    this.compaction = undefined
    this.compactions.set(eventID, record)
    return record
  }

  private contentOf(event: OpenCodeEvent): Decoded<OpenCodeEffect>[] {
    const decoded: Decoded<OpenCodeEffect>[] = []
    // A stopped or failed step spent what it streamed before it stopped, and says so as an ended one does.
    const step = event.type === "session.step.ended" || event.type === "session.step.failed" ? event.data : undefined
    if (step?.tokens) {
      const tokens = openCodeTokens(step.tokens)
      const observations: UsageObservation[] = [{ kind: "spent", tokens }]
      if (step.cost) observations.push({ kind: "costSpent", amount: step.cost, currency: "USD" })
      if (step.sessionID === this.root) observations.push({ kind: "call", tokens })
      decoded.push(...this.usage(...observations))
    }
    // The observer reads the call's name: a start opens it and a result closes it.
    const ends = event.type === "session.tool.success" || event.type === "session.tool.failed"
    const ending = ends ? this.agentCall(event) : undefined
    if (ending) decoded.push(ending)
    for (const update of openCodeEventUpdates(this.content, event, (type) => decoded.push({ kind: "unknown", type, reason: "unknown", raw: z.json().parse(event) })))
      decoded.push({ kind: "update", update })
    const call = ends ? undefined : this.agentCall(event)
    if (call) decoded.push(call)
    return decoded
  }

  private agentCall(event: OpenCodeEvent): Decoded<OpenCodeEffect> | undefined {
    if (!("sessionID" in event.data) || event.data.sessionID !== this.root) return undefined
    switch (event.type) {
      case "session.tool.called":
        return { kind: "effect", effect: { type: "agent-call", call: { sessionId: event.data.sessionID, toolCallId: event.data.id,
          title: this.content.name(event.data.sessionID, event.data.id), rawInput: event.data.input, status: "in_progress" } } }
      case "session.tool.progress":
        return { kind: "effect", effect: { type: "agent-call", call: { sessionId: event.data.sessionID, toolCallId: event.data.id, rawOutput: { metadata: event.data.metadata } } } }
      case "session.tool.success":
      case "session.tool.failed":
        return { kind: "effect", effect: { type: "agent-call", call: { sessionId: event.data.sessionID, toolCallId: event.data.id,
          rawOutput: { metadata: event.data.metadata }, status: event.type === "session.tool.success" ? "completed" : "failed" } } }
      default:
        return undefined
    }
  }
}
