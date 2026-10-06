import type { OpenCodeEvent } from "@opencode/client"
import { z } from "zod"
import type { AccessTier } from "../../contracts/access.js"
import type { Decoded } from "../../contracts/native-decoding.js"
import type { TokenCounts } from "../../contracts/providers-acp.js"
import { SessionUsage, type UsageObservation } from "../../session-usage.js"
import { openCodeModeForAgent } from "./access.js"
import type { OpenCodeAgents } from "./agents.js"
import { OpenCodeShells } from "./background.js"
import type { OpenCodeModelRef } from "./catalog.js"
import { OpenCodeContent } from "./content.js"
import { openCodeIgnores } from "./notices.js"

/** OpenCode's facts the driver acts on beyond the transcript. */
export type OpenCodeEffect =
  /** Inbox receipts, execution ends and a failed compaction: the driver binds them to its turn. */
  | { type: "turn" }
  /** A permission or form request, kept in the driver's request store. */
  | { type: "request" }
  /** Models, agents, commands or skills changed for this directory; the driver reloads the catalog. */
  | { type: "catalog" }
  /** An MCP server's status changed; the driver reads the new state back. */
  | { type: "mcp" }
  | { type: "model"; model: OpenCodeModelRef }
  /** A root tool call, for the subagent observer. */
  | { type: "agent-call"; call: Parameters<OpenCodeAgents["observe"]>[0] }

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
const REQUESTS = new Set<string>(["form.created", "form.replied", "form.cancelled", "permission.asked", "permission.replied"])
const CATALOG = new Set<string>(["catalog.updated", "agent.updated", "command.updated", "skill.updated"])
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
])

const SessionScope = z.object({ sessionID: z.string() })

/** OpenCode counts reasoning beside output and cached input beside input. */
function openCodeTokens(tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }): TokenCounts {
  const counts: TokenCounts = {
    input: tokens.input,
    cacheRead: tokens.cache.read,
    cacheWrite: tokens.cache.write,
    output: tokens.output + tokens.reasoning,
  }
  if (tokens.reasoning) counts.reasoning = tokens.reasoning
  return counts
}

/** A catalog change for `cwd`; it arrives before the session exists too. */
export function openCodeCatalogChange(event: OpenCodeEvent, cwd: string): boolean {
  return (event.type === "catalog.updated" || event.type === "agent.updated" || event.type === "command.updated" || event.type === "skill.updated")
    && (!event.location || event.location.directory === cwd)
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
      if (openCodeCatalogChange(event, this.cwd)) decoded.push({ kind: "effect", effect: { type: "catalog" } })
      return decoded
    }
    if (REQUESTS.has(event.type)) return [...decoded, { kind: "effect", effect: { type: "request" } }]
    if (event.type === "mcp.status.changed") {
      if (!event.location || event.location.directory === this.cwd) decoded.push({ kind: "effect", effect: { type: "mcp" } })
      return decoded
    }
    if (TURN.has(event.type)) return [...decoded, ...this.turn(event)]
    if (SESSION_STATE.has(event.type)) return [...decoded, ...this.session(event)]
    if (openCodeIgnores(event)) return decoded
    const scope = SessionScope.safeParse(event.data).data
    if (!scope) return [...decoded, { kind: "unknown", type: event.type, reason: "unknown", raw: z.json().parse(event) }]
    if (!this.owns(scope.sessionID)) return decoded
    return [...decoded, ...this.contentOf(event)]
  }

  private turn(event: OpenCodeEvent): Decoded<OpenCodeEffect>[] {
    const decoded: Decoded<OpenCodeEffect>[] = []
    if ((event.type === "session.execution.failed" || event.type === "session.execution.interrupted") && this.children.has(event.data.sessionID))
      for (const update of this.content.settle(event.data.sessionID, event.type === "session.execution.failed" ? "failed" : "cancelled", "The subagent stopped before this call finished."))
        decoded.push({ kind: "update", update })
    if (event.type === "session.compaction.failed" && event.data.sessionID === this.root) decoded.push({ kind: "activity", activity: null })
    decoded.push({ kind: "effect", effect: { type: "turn" } })
    return decoded
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
        return [{ kind: "activity", activity: { kind: "compacting" } }]
      case "session.compaction.ended":
        return [{
          kind: "compacted",
          compaction: { trigger: event.data.reason === "auto" ? "automatic" : "manual", tokensBefore: this.meter.current?.used, summary: event.data.text },
          source: event.id,
        }, ...this.usage({ kind: "compacted" })]
      default:
        return []
    }
  }

  private contentOf(event: OpenCodeEvent): Decoded<OpenCodeEffect>[] {
    const decoded: Decoded<OpenCodeEffect>[] = []
    if (event.type === "session.step.ended") {
      const tokens = openCodeTokens(event.data.tokens)
      const observations: UsageObservation[] = [{ kind: "spent", tokens }]
      if (event.data.cost > 0) observations.push({ kind: "costSpent", amount: event.data.cost, currency: "USD" })
      if (event.data.sessionID === this.root) observations.push({ kind: "call", tokens })
      decoded.push(...this.usage(...observations))
    }
    // The observer reads the call's name: a start opens it and a result closes it.
    const ends = event.type === "session.tool.success" || event.type === "session.tool.failed"
    const ending = ends ? this.agentCall(event) : undefined
    if (ending) decoded.push(ending)
    for (const update of this.content.observe(event, (type) => decoded.push({ kind: "unknown", type, reason: "unknown", raw: z.json().parse(event) })))
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
