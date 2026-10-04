import { z } from "zod"
import {
  codexErrorClass,
  codexFailureEvent,
  codexPresentation,
  codexPrompt,
  codexPromptImages,
  codexWarningEvent,
  firstLine,
} from "@mako/sessions/codex-presentation"
import { event, mcpServerFailedEvent, type TranscriptEvent } from "@mako/sessions/events"
import { boundedText, type JsonObject, type JsonRpcId, type JsonValue } from "../../codex-app-json.js"
import {
  parseNotification,
  type PatchNotification,
  type ProtocolNotification,
  type StreamDeltaNotification,
  type ToolOutputNotification,
} from "../../codex-app-parse.js"
import type { ItemTracker, ThreadItem, Turn } from "../../codex-app-types.js"
import { decoded, type Decoded } from "../../contracts/native-decoding.js"
import type { NativeActivityObservation } from "../../contracts/native-activity.js"
import type { NativeQuestion, NativeQuestionAnswer } from "../../contracts/live-questions.js"
import type { LiveSessionState } from "../../contracts/providers-acp.js"
import { SessionUsage, type UsageObservation } from "../../session-usage.js"
import type { CodexAgentItem } from "./agents.js"
import { codexAnsweredQuestions, codexAsyncQuestion } from "./questions.js"
import { codexUpdatedWindows } from "./rate-limits.js"

/**
 * Codex app-server notifications as Mako's shared decoded events. Pure: it
 * reads the notification, the session view it was given and its own
 * stream-assembly state, so a recorded session decodes the same every time
 * (`scripts/fixtures/native-decoding/codex`). The transport in
 * `codex-app-protocol.ts` owns JSON-RPC, server requests and everything
 * that answers Codex.
 */

/** What only the Codex driver acts on. */
export type CodexEffect =
  | { type: "turn-started"; turnId: string }
  /** Before the turn's state settles: requests it raised close. */
  | { type: "turn-ending"; turnId: string }
  /** After: background terminals are re-read, a compaction it ran resolves. */
  | { type: "turn-ended"; turnId: string; error?: string; stop: string }
  | { type: "compaction-item"; turnId: string }
  | { type: "server-request-resolved"; requestId: JsonRpcId }
  /** A subagent's thread started or finished a turn. */
  | { type: "subagent-turn"; threadId: string; completed: boolean }
  | { type: "agents"; item: CodexAgentItem; replay: boolean }
  | { type: "question"; question: NativeQuestion }
  | { type: "question-answer"; answer: NativeQuestionAnswer }
  /** A command's item completed, so its terminal no longer runs. */
  | { type: "command-ended"; itemId: string }
  | { type: "command-started"; threadId: string; turnId: string; itemId: string; processId?: string }

export type CodexDecoded = Decoded<CodexEffect>

/** The session the decoder reads; the transport's context is one. */
export interface CodexDecoderView {
  readonly threadId: string | null
  readonly state: Pick<LiveSessionState, "title" | "usage">
}

export interface CodexNotification {
  method: string
  params: JsonObject
}

/**
 * Notifications that are bookkeeping for Codex's own clients: thread
 * lifecycle Mako drives itself, account and app state, realtime audio, raw
 * model frames, and duplicates of events handled elsewhere. Known here so
 * the unknown-record log keeps to events Mako has yet to translate. Checked on 0.159.
 */
export const CODEX_SILENT_NOTIFICATIONS: ReadonlySet<string> = new Set([
  // Superseded by the contextCompaction item.
  "thread/compacted",
  "thread/started",
  "thread/archived",
  "thread/unarchived",
  "thread/deleted",
  "thread/reverted",
  "thread/status/changed",
  "thread/closed",
  "thread/settings/updated",
  "thread/attachment/updated",
  "thread/queue/changed",
  "thread/project/updated",
  "thread/environment/connected",
  "thread/environment/disconnected",
  "thread/goal/updated",
  "thread/goal/cleared",
  "thread/realtime/started",
  "thread/realtime/closed",
  "thread/realtime/error",
  "thread/realtime/sdp",
  "thread/realtime/itemAdded",
  "thread/realtime/item/started",
  "thread/realtime/item/completed",
  "thread/realtime/item/transcript/delta",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "project/changed",
  "skills/changed",
  "app/list/updated",
  "account/updated",
  "account/login/completed",
  "account/gatewayOAuth/changed",
  "remoteControl/status/changed",
  "externalAgentConfig/import/progress",
  "externalAgentConfig/import/completed",
  "mcpServer/oauthLogin/completed",
  "mcpServer/event/stream/notification",
  "fs/changed",
  "command/exec/outputDelta",
  "process/outputDelta",
  "process/exited",
  "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted",
  "windows/worldWritableWarning",
  "windowsSandbox/setupCompleted",
  "turn/moderationMetadata",
  // The fileChange items carry each edit; this is the turn's aggregate diff.
  "turn/diff/updated",
  "hook/started",
  "hook/completed",
  "model/verification",
  "item/commandExecution/terminalInteraction",
  "rawResponse/completed",
  "rawResponseItem/completed",
])

/** Notifications the decoder gives a meaning; with the silent ones, every kind it knows. */
export const CODEX_DECODED_NOTIFICATIONS: ReadonlySet<string> = new Set([
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryPartAdded",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed",
  "turn/plan/updated",
  "error",
  "serverRequest/resolved",
  "thread/tokenUsage/updated",
  "thread/name/updated",
  "warning",
  "guardianWarning",
  "configWarning",
  "deprecationNotice",
  "autoApprovalReview/strictReviewRequired",
  "model/rerouted",
  "model/safetyBuffering/updated",
  "mcpServer/startupStatus/updated",
  "modelProvider/authRecoveryStarted",
  "modelProvider/authRecoveryCompleted",
  "account/rateLimits/updated",
])

const MAX_TOOL_OUTPUT = 32 * 1024
const MAX_STREAM_COMPARE = 128 * 1024
const MAX_TRACKED_ITEMS = 2048
const MAX_REPLAY_ITEMS = 1000
const MAX_NOTICES = 256
const REVIEWING_APPROVAL = "Reviewing the approval"
const CHECKING_RESPONSE = "Checking the response"
const REFRESHING_SIGN_IN = "Refreshing sign-in"
/** Codex 0.159's `ModelRerouteReason`, in plain words. */
const REROUTE_REASONS = new Map([["highRiskCyberActivity", "cybersecurity safety check"]])
/** Codex 0.159's `McpServerStartupFailureReason`, in plain words. */
const MCP_FAILURES = new Map([["reauthenticationRequired", "sign-in required"]])
const PatchKindSchema = z.object({
  type: z.enum(["add", "delete", "update"]),
  move_path: z.string().nullish(),
})
const SearchActionSchema = z.object({
  query: z.string().nullish(),
  queries: z.array(z.string()).nullish(),
  url: z.string().nullish(),
})
const SearchResultSchema = z.object({ title: z.string().optional(), url: z.string().min(1) })
type FileChange = Extract<ThreadItem, { type: "fileChange" }>["changes"][number]

export class CodexDecoder {
  private readonly items = new Map<string, ItemTracker>()
  private readonly notices = new Set<string>()
  /** Rows whose output is a patch, so streamed output after it starts its own paragraph. */
  private readonly patched = new WeakSet<ItemTracker>()
  private currentTurnId: string | null = null
  /** The waiting activity this decoder reported and has yet to end. */
  private waiting: string | undefined
  /** Context tokens when the running compaction started. */
  private compactingFrom: number | undefined
  private readonly meter = new SessionUsage()

  private readonly view: CodexDecoderView

  constructor(view: CodexDecoderView) {
    this.view = view
  }

  /** One notification as decoded events; `[]` for one known to show nothing. */
  decode(message: CodexNotification): CodexDecoded[] {
    const out: CodexDecoded[] = []
    if (CODEX_SILENT_NOTIFICATIONS.has(message.method)) return out
    if (message.method === "account/rateLimits/updated") {
      const windows = codexUpdatedWindows(message.params)
      if (windows.length) out.push(decoded.usage(windows))
      return out
    }
    const notification = parseNotification(message.method, message.params)
    if (!notification) {
      const reason = CODEX_DECODED_NOTIFICATIONS.has(message.method) ? "unreadable" : "unknown"
      out.push(decoded.unknown(message.method, message.params, reason))
    } else this.notification(out, notification, message.params)
    return out
  }

  /** A resumed thread's items, as the transcript it already had. */
  replay(turns: Turn[]): CodexDecoded[] {
    const out: CodexDecoded[] = []
    const entries = turns.flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item })))
    for (const entry of entries.slice(-MAX_REPLAY_ITEMS)) this.item(out, entry.turnId, entry.item, true, true)
    this.items.clear()
    return out
  }

  /** Stream assembly ends with the process. */
  forgetItems(): void {
    this.items.clear()
  }

  private notification(out: CodexDecoded[], notification: ProtocolNotification, raw: JsonObject): void {
    if (notification.method === "invalid") {
      out.push(decoded.unknown(notification.kind, raw, "unreadable"))
      return
    }
    const thread = this.view.threadId
    if (notification.threadId && thread && notification.threadId !== thread) {
      if (notification.method === "turn/started" || notification.method === "turn/completed")
        out.push(decoded.effect({ type: "subagent-turn", threadId: notification.threadId, completed: notification.method === "turn/completed" }))
      if (notification.method === "item/started" && notification.item.type === "commandExecution")
        out.push(decoded.effect({ type: "command-started", threadId: notification.threadId, turnId: notification.turnId, itemId: notification.item.id, processId: notification.item.processId }))
      return
    }
    switch (notification.method) {
      case "turn/started":
        this.currentTurnId = notification.turnId
        this.waiting = undefined
        out.push(
          decoded.effect({ type: "turn-started", turnId: notification.turnId }),
          decoded.state({ status: "running", nativeRunId: notification.turnId, error: undefined }),
        )
        return
      case "turn/completed":
        this.completeTurn(out, notification.turn)
        return
      case "item/started":
        this.item(out, notification.turnId, notification.item, false, false, raw["item"])
        return
      case "item/completed":
        if (notification.item.type === "contextCompaction")
          out.push(decoded.effect({ type: "compaction-item", turnId: notification.turnId }))
        this.item(out, notification.turnId, notification.item, true, false, raw["item"])
        return
      case "item/agentMessage/delta":
        this.streamDelta(out, notification, "text")
        return
      case "item/plan/delta": {
        const tracker = this.tracker(notification.turnId, notification.itemId)
        out.push(decoded.update({ kind: "proposed-plan", id: tracker.acpId, text: notification.delta, status: "drafting" }))
        return
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        this.streamDelta(out, notification, "thinking")
        return
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
      case "item/mcpToolCall/progress":
        this.streamToolOutput(out, notification)
        return
      case "item/fileChange/patchUpdated":
        this.replaceToolOutput(out, notification, patchText(notification.changes))
        return
      case "turn/plan/updated":
        out.push(decoded.update({
          kind: "plan",
          entries: notification.plan.map((step) => ({
            content: step.step,
            status: step.status === "inProgress" ? "in_progress" : step.status,
          })),
        }))
        return
      case "error":
        if (notification.willRetry) {
          this.waiting = undefined
          out.push(decoded.activity(retrying(notification.message, notification.variant)))
        } else out.push(decoded.state({ error: notification.message }))
        return
      case "serverRequest/resolved":
        out.push(decoded.effect({ type: "server-request-resolved", requestId: notification.requestId }))
        return
      case "thread/tokenUsage/updated": {
        const { used, size, total } = notification
        const observations: UsageObservation[] = [{ kind: "context", used, size }]
        if (total) observations.push({ kind: "total", tokens: total })
        const usage = this.meter.observe(...observations)
        if (usage) out.push(decoded.state({ usage }))
        return
      }
      case "warning":
      case "guardianWarning": {
        // Codex's own UI leaves approvals out; denials and failures stay.
        if (notification.method === "guardianWarning" &&
          notification.message.startsWith("Automatic approval review approved ("))
          return
        // Outside a turn, Codex warns about what it loaded: its config, hooks,
        // skills. It repeats `configWarning` here in other words.
        const marker = codexWarningEvent(notification.message)
        if (this.currentTurnId === null && notification.method === "warning") marker.setup = true
        this.notice(out, notification.method, marker)
        return
      }
      case "configWarning":
      case "deprecationNotice":
        this.notice(out, notification.method, { ...codexWarningEvent(notification.summary, notification.details), setup: true })
        return
      case "autoApprovalReview/strictReviewRequired":
        this.notice(out, notification.method, codexWarningEvent("This request needs extra safety checks, so some tool calls may take longer."))
        return
      case "model/rerouted": {
        const reason = REROUTE_REASONS.get(notification.reason) ?? words(notification.reason)
        this.notice(out, notification.method, event("Model changed", `${notification.fromModel} → ${notification.toModel} · ${reason}`))
        return
      }
      case "mcpServer/startupStatus/updated": {
        if (notification.status !== "failed") return
        const failure = notification.failureReason
        const reason = notification.error ??
          (failure ? MCP_FAILURES.get(failure) ?? words(failure) : undefined)
        this.notice(out, notification.method, mcpServerFailedEvent(notification.name, reason))
        return
      }
      case "model/safetyBuffering/updated":
        if (notification.turnId !== this.currentTurnId) return
        if (notification.show) this.wait(out, CHECKING_RESPONSE)
        else this.endWait(out, CHECKING_RESPONSE)
        return
      case "item/autoApprovalReview/started":
        this.wait(out, REVIEWING_APPROVAL)
        return
      case "item/autoApprovalReview/completed":
        // A denial arrives as its own guardianWarning.
        this.endWait(out, REVIEWING_APPROVAL)
        return
      case "modelProvider/authRecoveryStarted":
        this.wait(out, REFRESHING_SIGN_IN)
        return
      case "modelProvider/authRecoveryCompleted":
        this.endWait(out, REFRESHING_SIGN_IN)
        return
      case "thread/name/updated":
        if (notification.name?.trim() && notification.name !== this.view.state.title)
          out.push(decoded.state({ title: notification.name }))
        return
      case "item/reasoning/summaryPartAdded":
        // Codex joins summary parts with a blank line once the item completes.
        if (notification.summaryIndex > 0)
          this.streamDelta(out, { ...notification, method: "item/reasoning/summaryTextDelta", delta: "\n\n" }, "thinking")
        return
    }
  }

  private completeTurn(out: CodexDecoded[], turn: Turn): void {
    const error = turn.error?.message || undefined
    const stop = turn.status === "inProgress" ? "completed" : turn.status
    if (error || stop === "failed")
      out.push(decoded.marker(codexFailureEvent(turn.error?.variant, error), `${turn.id}:failed`))
    this.currentTurnId = null
    this.waiting = undefined
    for (const key of this.items.keys())
      if (key.startsWith(`${turn.id}\u0000`)) this.items.delete(key)
    const ended: CodexEffect = { type: "turn-ended", turnId: turn.id, stop }
    if (error) ended.error = error
    out.push(
      decoded.effect({ type: "turn-ending", turnId: turn.id }),
      decoded.state({ status: error || stop === "failed" ? "failed" : "ready", lastStop: stop, error }),
      decoded.effect(ended),
    )
  }

  /**
   * A notice Codex sends without an id of its own. Its marker is named by
   * the method and what it says, so the row traces back to its kind and the
   * same notice sent again is drawn once.
   */
  private notice(out: CodexDecoded[], method: string, marker: TranscriptEvent): void {
    // A setup notice is one fact however Codex words its body.
    const key = marker.setup
      ? `setup\u0000${marker.label}\u0000${marker.detail ?? ""}`
      : `${marker.label}\u0000${marker.detail ?? ""}\u0000${marker.body ?? ""}`
    if (this.notices.has(key)) return
    if (this.notices.size >= MAX_NOTICES) this.notices.delete(this.notices.values().next().value!)
    this.notices.add(key)
    out.push(decoded.marker(marker, `${method}:${fingerprint(key)}`))
  }

  private wait(out: CodexDecoded[], label: string): void {
    if (this.waiting === label) return
    this.waiting = label
    out.push(decoded.activity({ kind: "waiting", label }))
  }

  /** End a waiting activity this decoder reported, never one it did not. */
  private endWait(out: CodexDecoded[], label: string): void {
    if (this.waiting !== label) return
    this.waiting = undefined
    out.push(decoded.activity(null))
  }

  private streamDelta(out: CodexDecoded[], notification: StreamDeltaNotification, kind: "text" | "thinking"): void {
    if (!notification.turnId || !notification.itemId || !notification.delta) return
    // Output arriving is the response passing its check; Codex sends no end.
    if (this.waiting === CHECKING_RESPONSE) this.endWait(out, CHECKING_RESPONSE)
    const tracker = this.tracker(notification.turnId, notification.itemId)
    if (kind === "text") {
      tracker.textDelta = true
      tracker.text = appendComparable(tracker.text, notification.delta)
    } else {
      tracker.thinkingDelta = true
      tracker.thinking = appendComparable(tracker.thinking, notification.delta)
    }
    out.push(decoded.update({ kind, id: tracker.acpId, text: notification.delta }))
  }

  private streamToolOutput(out: CodexDecoded[], notification: ToolOutputNotification): void {
    if (!notification.delta || !notification.turnId || !notification.itemId) return
    const tracker = this.tracker(notification.turnId, notification.itemId)
    const joint = this.patched.delete(tracker) && tracker.output ? "\n\n" : ""
    tracker.output = tail(tracker.output + joint + notification.delta, MAX_TOOL_OUTPUT)
    out.push(decoded.update({ kind: "tool-update", id: tracker.acpId, output: tracker.output }))
  }

  private replaceToolOutput(out: CodexDecoded[], notification: PatchNotification, output: string): void {
    if (!notification.turnId || !notification.itemId) return
    const tracker = this.tracker(notification.turnId, notification.itemId)
    tracker.output = boundedText(output, MAX_TOOL_OUTPUT)
    this.patched.add(tracker)
    out.push(decoded.update({ kind: "tool-update", id: tracker.acpId, output: tracker.output }))
  }

  private item(out: CodexDecoded[], turnId: string, item: ThreadItem, completed: boolean, replay = false, raw?: JsonValue): void {
    if (!turnId) return
    if (!replay && this.waiting === CHECKING_RESPONSE) this.endWait(out, CHECKING_RESPONSE)
    const tracker = this.tracker(turnId, item.id)
    const thread = this.view.threadId
    switch (item.type) {
      case "userMessage": {
        if (!completed) return
        const originalText = item.content
          .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
          .join("\n")
        if (thread)
          for (const answer of codexAnsweredQuestions(thread, originalText))
            out.push(decoded.effect({ type: "question-answer", answer }))
        if (!replay) return
        const attachments = item.content.flatMap((part) => (part.attachment ? [part.attachment] : []))
        const text = codexPrompt(originalText) ?? ""
        if (!attachments.length) attachments.push(...codexPromptImages(originalText))
        if (text || attachments.length) out.push(decoded.update({ kind: "user", text, attachments }))
        return
      }
      case "attachment":
        if (completed) out.push(decoded.update({ kind: "attachment", attachment: item.attachment }))
        return
      case "agentMessage":
        if (!completed) return
        finalText(out, "text", item.text, tracker.acpId)
        if (item.questions && thread)
          out.push(decoded.effect({ type: "question", question: codexAsyncQuestion(thread, turnId, item.id, item.questions) }))
        return
      case "reasoning":
        if (completed) finalText(out, "thinking", [...item.summary, ...item.content].filter(Boolean).join("\n\n"), tracker.acpId)
        return
      case "commandExecution":
        if (!completed && !replay && thread) out.push(decoded.effect({ type: "command-started", threadId: thread, turnId, itemId: item.id, processId: item.processId }))
        startTool(out, tracker, item.command || "Command", "exec_command", item.status, { command: item.command })
        if (completed) {
          finishTool(out, tracker, item.status, (item.aggregatedOutput ?? tracker.output) || undefined)
          if (!replay) out.push(decoded.effect({ type: "command-ended", itemId: item.id }))
        }
        return
      case "fileChange": {
        const paths = item.changes.flatMap((change) => (change.path === undefined ? [] : [change.path]))
        startTool(out, tracker, paths.length ? `Edit ${paths.join(", ")}` : "File changes", "apply_patch", item.status,
          paths.length ? { path: paths[0], paths } : undefined)
        if (completed) finishTool(out, tracker, item.status, patchText(item.changes))
        return
      }
      case "mcpToolCall":
        startTool(out, tracker, `${item.server}: ${item.tool}`, `mcp__${item.server}__${item.tool}`, item.status, item.arguments ?? undefined)
        if (completed) {
          const output = item.error?.message ||
            (item.result === null ? tracker.output : boundedJson(item.result))
          finishTool(out, tracker, item.status, output || undefined)
        }
        return
      case "dynamicToolCall":
        startTool(out, tracker, `${item.namespace ? `${item.namespace}.` : ""}${item.tool}`, item.namespace ? `${item.namespace}.${item.tool}` : item.tool, item.status,
          item.arguments ?? undefined)
        if (completed) finishTool(out, tracker, item.status, item.contentItems ? boundedJson(item.contentItems) : undefined)
        return
      case "webSearch": {
        const input = item.action ?? { query: item.query }
        const title = item.query || searchTarget(item.action) || "Web search"
        startTool(out, tracker, title, "web_search", completed ? "completed" : "inProgress", input)
        // The query is empty until the search ends.
        if (completed)
          out.push(decoded.update({
            kind: "tool-update",
            id: tracker.acpId,
            title: boundedText(title, 500),
            input: boundedJson(input),
            status: "completed",
            output: searchResults(item.results),
          }))
        return
      }
      case "sleep":
        startTool(out, tracker, `Sleep ${duration(item.durationMs)}`, "sleep", completed ? "completed" : "inProgress")
        if (completed) finishTool(out, tracker, "completed")
        return
      case "enteredReviewMode":
        if (completed) {
          const line = firstLine(item.review)
          out.push(decoded.marker(event("Review mode started", line, item.review === line ? undefined : item.review), item.id))
        }
        return
      case "exitedReviewMode":
        if (completed) out.push(decoded.marker(event("Review mode ended", undefined, item.review), item.id))
        return
      case "hookPrompt":
        return
      case "collabAgentToolCall":
      case "subAgentActivity":
        out.push(decoded.effect({ type: "agents", item, replay }))
        return
      case "plan":
        out.push(decoded.update({
          kind: "proposed-plan",
          id: tracker.acpId,
          text: item.text,
          status: completed ? "proposed" : "drafting",
          replace: true,
        }))
        return
      case "contextCompaction":
        if (replay) {
          if (completed) out.push(decoded.compacted(undefined, item.id))
          return
        }
        this.waiting = undefined
        if (completed) {
          // Codex reports the compacted estimate before this item completes.
          const tokensBefore = this.compactingFrom
          const tokensAfter = this.meter.current?.used
          this.compactingFrom = undefined
          out.push(decoded.compacted(tokensBefore ? { tokensBefore, ...tokensAfter !== undefined && tokensAfter < tokensBefore && { tokensAfter } } : undefined, item.id))
        } else {
          this.compactingFrom = this.meter.current?.used
          out.push(decoded.activity({ kind: "compacting" }))
        }
        return
      case "unsupported":
        out.push(decoded.unknown(`item/${item.sourceType}`, raw ?? { type: item.sourceType, id: item.id }))
        return
    }
  }

  private tracker(turnId: string, itemId: string): ItemTracker {
    const key = `${turnId}\u0000${itemId}`
    const current = this.items.get(key)
    if (current) return current
    if (this.items.size >= MAX_TRACKED_ITEMS) this.items.delete(this.items.keys().next().value!)
    const tracker: ItemTracker = {
      acpId: `codex:${turnId}:${itemId}`,
      started: false,
      textDelta: false,
      text: "",
      thinkingDelta: false,
      thinking: "",
      output: "",
    }
    this.items.set(key, tracker)
    return tracker
  }
}

/**
 * Codex numbers its own retries in the message ("Reconnecting... 2/5") and
 * classifies what failed; the counter becomes the attempt.
 */
function retrying(message: string, variant: string | undefined): NativeActivityObservation {
  const counter = /^Reconnecting\.\.\.\s*(\d+)\/(\d+)\s*$/.exec(message)
  const said = message.replace(/^Reconnecting\.\.\.\s*/, "")
  // Codex tags every stream retry `responseStreamDisconnected`, whatever failed.
  const reason = (variant === "responseStreamDisconnected" ? undefined : codexErrorClass(variant)) ??
    (counter || !said ? undefined : `${said[0]?.toUpperCase() ?? ""}${said.slice(1)}`)
  const activity: NativeActivityObservation = { kind: "retrying" }
  if (counter) {
    activity.attempt = Number(counter[1])
    activity.maxAttempts = Number(counter[2])
  }
  if (reason) activity.reason = reason
  return activity
}

/**
 * Codex names its items by shape, so the tool name and the argument the row
 * shows (the command, the file) are supplied here. Without the input the
 * shell row had no command on it at all, live or expanded.
 */
function startTool(out: CodexDecoded[], tracker: ItemTracker, title: string, name: string, status: string, input?: JsonValue): void {
  if (tracker.started) return
  tracker.started = true
  out.push(decoded.update({
    kind: "tool",
    id: tracker.acpId,
    title: boundedText(title, 500),
    name,
    status: toolStatus(status),
    input: input === undefined ? undefined : boundedJson(input),
  }))
}

function finishTool(out: CodexDecoded[], tracker: ItemTracker, status: string, output?: string): void {
  out.push(decoded.update({ kind: "tool-update", id: tracker.acpId, status: toolStatus(status), output: output || undefined }))
}

function finalText(out: CodexDecoded[], kind: "text" | "thinking", source: string, id: string): void {
  const final = codexPresentation(source)
  // A completed item is authoritative, including corrections and empty replacements.
  if (!final) {
    out.push(decoded.update({ kind, id, text: "", replace: true }))
    return
  }
  for (let offset = 0; offset < final.length; offset += MAX_TOOL_OUTPUT)
    out.push(decoded.update({ kind, id, text: final.slice(offset, offset + MAX_TOOL_OUTPUT), replace: offset === 0 }))
}

/** A variant Mako has no words for yet, as lowercase words. */
function words(identifier: string): string {
  return identifier.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
}

function toolStatus(status: string): string {
  if (status === "inProgress" || status === "pending") return "pending"
  if (status === "completed") return "completed"
  return "failed"
}

/** FNV-1a: a short, stable name for a notice's text. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193)
  return (hash >>> 0).toString(16).padStart(8, "0")
}

function appendComparable(current: string | null, delta: string): string | null {
  if (current === null || current.length + delta.length > MAX_STREAM_COMPARE) return null
  return current + delta
}

/**
 * Codex's edits as one patch a reader can follow: each file's heading, then
 * its unified diff, or its whole content for a file added or deleted.
 */
function patchText(changes: FileChange[]): string {
  const files = changes.map((change) => {
    const kind = PatchKindSchema.safeParse(change.kind)
    const type = kind.success ? kind.data.type : "update"
    const moved = kind.success ? kind.data.move_path : undefined
    const path = change.path ?? "file"
    const diff = change.diff ?? ""
    switch (type) {
      case "add":
        return `Add ${path}\n${prefixLines(diff, "+")}`
      case "delete":
        return `Delete ${path}\n${prefixLines(diff, "-")}`
      case "update":
        return `Update ${moved ? `${path} → ${moved}` : path}\n${diff.trimEnd()}`
    }
  })
  return boundedText(files.join("\n\n"), MAX_TOOL_OUTPUT)
}

function prefixLines(text: string, prefix: string): string {
  return text.trimEnd().split("\n").map((line) => `${prefix}${line}`).join("\n")
}

function searchTarget(action: JsonObject | null): string | undefined {
  const target = SearchActionSchema.safeParse(action)
  if (!target.success) return undefined
  const { query, queries, url } = target.data
  return query || queries?.join(" · ") || url || undefined
}

/** Standalone search returns results out of band; hosted search returns none. */
function searchResults(results: JsonValue[] | null): string | undefined {
  const lines = (results ?? []).flatMap((result) => {
    const parsed = SearchResultSchema.safeParse(result)
    if (!parsed.success) return []
    const { title, url } = parsed.data
    return [title ? `${title}\n${url}` : url]
  })
  return lines.length ? boundedText(lines.join("\n\n"), MAX_TOOL_OUTPUT) : undefined
}

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`
}

function boundedJson(value: JsonValue): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return "[unserializable output]"
  }
}

function tail(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(-limit)
}
