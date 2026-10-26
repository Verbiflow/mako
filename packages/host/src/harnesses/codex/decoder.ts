import { codexCommand, codexErrorClass, codexWarningEvent, firstLine } from "@mako/sessions/codex-presentation"
import { CodexRecords, type CodexRead } from "@mako/sessions/codex-records"
import { event, mcpServerFailedEvent, type Compaction, type TranscriptEvent } from "@mako/sessions/events"
import type { LiveUpdate } from "@mako/sessions/live-content"
import { boundedText, objectValue, stringValue, type JsonRpcId } from "../../base/json-values.js"
import type { JsonObject } from "../../contracts/json.js"
import {
  parseNotification,
  type ProtocolNotification,
  type StreamDeltaNotification,
  type ToolOutputNotification,
} from "../codex-app-parse.js"
import type { ThreadItem, Turn } from "../codex-app-types.js"
import { decoded, type Decoded } from "../../contracts/native-decoding.js"
import type { NativeActivityObservation } from "../../contracts/native-activity.js"
import type { NativeQuestion, NativeQuestionAnswer } from "../../contracts/live-questions.js"
import type { LiveSessionState, TokenCounts } from "../../contracts/providers-acp.js"
import { contextOf, SessionUsage, tokensSince, type UsageObservation } from "../session-usage.js"
import type { CodexAgentItem } from "./agents.js"
import { codexGoalObservation, type CodexThreadGoal } from "./goals.js"
import { codexAnsweredQuestions, codexAsyncQuestion } from "./questions.js"
import { codexUpdatedWindows } from "./rate-limits.js"
import { codexInteractiveConfig } from "./settings.js"

/**
 * A Codex session as Mako's shared decoded events, from two sources that
 * never describe the same thing twice:
 *
 * - The thread's rollout records, read as Codex appends them during a turn
 *   (`CodexRolloutTail`), decoded by the one decoder saved history runs too
 *   (`CodexRecords` in `@mako/sessions/codex-records`). Everything the
 *   transcript shows comes from here: prompts Codex started itself, replies,
 *   reasoning, every call and its result, plans, reviews, compactions, a
 *   turn's failure or stop.
 * - The app-server's notifications, for what no record holds: the streamed
 *   text, reasoning and command output of an item still running, drawn under
 *   the id its record will have until that record lands and replaces it; a
 *   code cell's call while it runs; the turn's status, errors and retries;
 *   usage, rate limits, the thread's name and goal; warnings, MCP startup and
 *   the waits Codex reports; and the facts the driver acts on (`CodexEffect`).
 *   Approvals and questions are server requests the transport answers.
 *
 * Pure: it reads the messages, the session view it was given and its own
 * state, so a recorded session decodes the same every time
 * (`scripts/fixtures/native-decoding/codex`). The transport in
 * `codex-app-protocol.ts` owns JSON-RPC, server requests and the rollout.
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
  | { type: "agents"; item: CodexAgentItem; replay: boolean; toolId: string }
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
 * model frames, and what the rollout's records draw. Known here so the
 * unknown-record log keeps to events Mako has yet to translate. Checked on 0.159.
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
  // The patch's records carry each edit; this is the turn's aggregate diff.
  "turn/diff/updated",
  // The patch the model wrote is its call's record, which lands before Codex applies it.
  "item/fileChange/patchUpdated",
  // `update_plan`'s call record draws the plan.
  "turn/plan/updated",
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
  "item/mcpToolCall/progress",
  "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed",
  "error",
  "serverRequest/resolved",
  "thread/tokenUsage/updated",
  "thread/name/updated",
  "thread/goal/updated",
  "thread/goal/cleared",
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

/**
 * Server requests: approvals and the model's questions, each the
 * transport's card. A question's row is its call's record
 * (`request_user_input`), and the answer its output's.
 */
export const CODEX_SILENT_REQUESTS: ReadonlySet<string> = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
])

/** What a capture calls the records the driver read from the rollout. */
export const CODEX_ROLLOUT_RECORDS = "(rollout records)"

/** What live shows of one call's output: its head and its end, as the window keeps a streamed one. */
const MAX_TOOL_OUTPUT = 32 * 1024
/** Turns the app-server announced that the rollout may still name; a thread runs one at a time. */
const MAX_ANNOUNCED = 64
/** Records read before the app-server announced their turn: what Codex writes between its turns. */
const MAX_HELD_RECORDS = 256
/** Ids the records drew, which the app-server's late deltas for the same item no longer redraw. */
const MAX_LANDED = 4096
const MAX_NOTICES = 256
const REVIEWING_APPROVAL = "Reviewing the approval"
const CHECKING_RESPONSE = "Checking the response"
const REFRESHING_SIGN_IN = "Refreshing sign-in"
/** Codex 0.159's `ModelRerouteReason`, in plain words. */
const REROUTE_REASONS = new Map([["highRiskCyberActivity", "cybersecurity safety check"]])
/** Codex 0.159's `McpServerStartupFailureReason`, in plain words. */
const MCP_FAILURES = new Map([["reauthenticationRequired", "sign-in required"]])
/** What macOS `sandbox-exec` says when it runs inside another sandbox, so Codex's own can't start. */
const NESTED_SANDBOX = "sandbox-exec: sandbox_apply: Operation not permitted"

/** A rollout record that opens or closes a turn, and the turn it names. */
function turnBoundary(record: JsonObject): { started: boolean; turnId?: string } | undefined {
  if (stringValue(record["type"]) !== "event_msg") return undefined
  const payload = objectValue(record["payload"])
  const type = stringValue(payload?.["type"])
  const started = type === "task_started" || type === "turn_started"
  if (!started && type !== "task_complete" && type !== "turn_complete" && type !== "turn_aborted") return undefined
  const turnId = stringValue(payload?.["turn_id"])
  return turnId === undefined ? { started } : { started, turnId }
}

/** The record of a review mode starting, which Codex writes before the review's turn starts. */
function entersReview(record: JsonObject): boolean {
  const payload = objectValue(record["payload"])
  return stringValue(payload?.["type"]) === "item_completed" && stringValue(objectValue(payload?.["item"])?.["type"]) === "EnteredReviewMode"
}

export class CodexDecoder {
  /** The one decoder of the thread's rollout records. */
  private readonly rollout = new CodexRecords()
  /** The turn whose records are drawn; a record outside the turns Codex announced draws nothing. */
  private following: string | null = null
  private readonly announced = new Set<string>()
  private held: JsonObject[] = []
  /** Text, reasoning, plans and finished calls the records drew, by id. */
  private readonly landed = new Set<string>()
  /** Every call the records drew, finished or not. */
  private readonly calls = new Set<string>()
  /** Rows the app-server's items drew for a code cell's calls still running, until their records land. */
  private readonly running = new Set<string>()
  private readonly notices = new Set<string>()
  private currentTurnId: string | null = null
  /** The thread's goal while it is active, so Codex starts turns toward it on its own. */
  private goal: CodexThreadGoal | null = null
  /** Mako asked for the next turn: a prompt or a compaction. */
  private expectingTurn = false
  /** The running turn, when Codex started it toward its goal rather than for Mako. */
  private goalTurnId: string | null = null
  /** The waiting activity this decoder reported and has yet to end. */
  private waiting: string | undefined
  private readonly meter = new SessionUsage()
  /** The thread's running total at its latest reading, which every process of the thread continues. */
  private threadTotal: TokenCounts | undefined
  /**
   * The agent threads this thread spawned, and theirs, with each one's
   * running total at its latest reading: what each spends is the
   * conversation's, counted as it reports it (`agentSpend`).
   */
  private readonly agents = new Map<string, TokenCounts | undefined>()
  /**
   * A compaction the records drew, held until Codex names it a few records
   * on, so the marker is drawn once with its item's id and the context after.
   */
  private compaction: Compaction | undefined
  /** Whether the notice that Codex can't sandbox commands was drawn; Mako's own sandbox doesn't change while it runs. */
  private sandboxNoticed = false

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

  /** Records Codex appended to the thread's rollout, in order (`CodexRolloutTail`). */
  records(records: readonly JsonObject[]): CodexDecoded[] {
    const out: CodexDecoded[] = []
    for (const record of records) this.record(out, record)
    return out
  }

  /** Mako is about to start a turn, or its request for one failed; any other turn the thread starts is Codex's own. */
  expectTurn(expecting = true): void {
    this.expectingTurn = expecting
  }

  /** The running turn, if Codex started it toward its goal: a message sent now joins it. */
  goalTurn(): string | null {
    return this.goalTurnId
  }

  /** What the process streamed ends with it. */
  forgetItems(): void {
    this.running.clear()
  }

  private record(out: CodexDecoded[], record: JsonObject): void {
    const turn = turnBoundary(record)
    if (turn?.started && turn.turnId !== this.following) {
      const following = this.following
      this.following = (turn.turnId === undefined ? this.currentTurnId !== null : this.announced.has(turn.turnId)) ? (turn.turnId ?? this.currentTurnId) : null
      if (following === null && this.following !== null) {
        // An inline review records entering review mode just before its turn starts.
        const review: JsonObject[] = []
        while (this.held.length && entersReview(this.held.at(-1)!)) review.unshift(this.held.pop()!)
        this.held = []
        for (const entry of review) this.draw(out, entry)
      }
    }
    if (this.following === null) {
      this.held.push(record)
      if (this.held.length > MAX_HELD_RECORDS) this.held.shift()
      return
    }
    this.draw(out, record)
    if (turn && !turn.started && (turn.turnId === undefined || turn.turnId === this.following)) {
      this.rollout.flush()
      this.drawCompaction(out)
      this.following = null
    }
  }

  private draw(out: CodexDecoded[], record: JsonObject): void {
    for (const read of this.rollout.record(record)) this.read(out, read, record)
  }

  /** The app-server announced a turn of this thread: its records draw, those read before it included. */
  private announce(out: CodexDecoded[], turnId: string): void {
    this.announced.add(turnId)
    if (this.announced.size > MAX_ANNOUNCED) this.announced.delete(this.announced.values().next().value!)
    let start = this.held.length - 1
    for (; start >= 0; start--) {
      const turn = turnBoundary(this.held[start]!)
      if (turn?.started && (turn.turnId === undefined || turn.turnId === turnId)) break
    }
    if (start < 0) return
    const records = this.held.slice(start)
    this.held = this.held.slice(0, start)
    for (const record of records) this.record(out, record)
  }

  /** One thing a record means, as live draws it; `record` is the record, kept with what can't be read. */
  private read(out: CodexDecoded[], read: CodexRead, record: JsonObject): void {
    if (this.compaction && read.kind !== "compaction-named" && read.kind !== "usage" && read.kind !== "settings") this.drawCompaction(out)
    switch (read.kind) {
      case "update":
        // A call the records draw back where it started: the app-server drew its row then, which this only finishes.
        this.drawn(out, read.place && read.update.kind === "tool" ? finishing(read.update) : read.update)
        return
      case "marker":
        out.push(decoded.marker(read.marker, read.marker.source?.record))
        return
      case "compacted":
        this.compaction = read.compaction
        return
      case "compaction-named":
        if (!this.compaction) return
        if (read.tokensAfter !== undefined) this.compaction = { ...this.compaction, tokensAfter: read.tokensAfter }
        if (read.source) this.drawCompaction(out, read.source)
        return
      case "unread":
        if (read.reason !== "undrawn") out.push(decoded.unknown(`${CODEX_ROLLOUT_RECORDS} ${read.type}`, record, read.reason))
        return
      // Mako draws the prompts it sends; the app-server reports turns, usage and settings as they happen, and draws a cell's calls where they start.
      case "mark":
      case "turn":
      case "usage":
      case "settings":
      case "rolled-back":
      case "unplaced":
        return
    }
  }

  private drawCompaction(out: CodexDecoded[], source?: string): void {
    if (!this.compaction) return
    out.push(decoded.compacted(this.compaction, source))
    this.compaction = undefined
  }

  /** A record's content as the live transcript draws it, after which the app-server's stream for the same item stops. */
  private drawn(out: CodexDecoded[], update: LiveUpdate): void {
    switch (update.kind) {
      case "user":
        return
      case "text":
      case "thinking":
      case "proposed-plan":
        if (update.id !== undefined) this.land(update.id)
        out.push(decoded.update(update))
        return
      case "tool":
      case "tool-update": {
        this.calls.add(update.id)
        if (this.calls.size > MAX_LANDED) this.calls.delete(this.calls.values().next().value!)
        this.running.delete(update.id)
        if (update.status !== "pending") this.land(update.id)
        const bounded = update.output !== undefined && update.output.length > MAX_TOOL_OUTPUT ? { ...update, output: boundedText(update.output, MAX_TOOL_OUTPUT) } : update
        out.push(decoded.update(bounded))
        if (!this.sandboxNoticed && update.output?.includes(NESTED_SANDBOX)) {
          this.sandboxNoticed = true
          this.notice(out, CODEX_ROLLOUT_RECORDS, {
            ...event("Codex can't sandbox commands", "Mako is running inside a macOS sandbox, so Codex's own sandbox can't start.",
              "Every command Codex sandboxes fails. Switch to Full access, or start Mako outside the sandbox."),
            tone: "warning",
          })
        }
        return
      }
      default:
        out.push(decoded.update(update))
    }
  }

  private land(id: string): void {
    this.landed.add(id)
    if (this.landed.size > MAX_LANDED) this.landed.delete(this.landed.values().next().value!)
  }

  /**
   * What the thread's total adds since its last reading. The first reading has no
   * earlier one: a call in a turn this decoder saw start counts itself, and a
   * resumed thread's repeat of its last reading only sets where counting starts.
   */
  private threadSpend(total: TokenCounts, call: TokenCounts | undefined): TokenCounts | undefined {
    const before = this.threadTotal
    this.threadTotal = total
    const added = before && tokensSince(before, total)
    return added ?? call
  }

  /** The agent threads an item says were spawned: a `started` activity (multi-agent v2) or a spawn call's receivers (v1). */
  private spawned(item: ThreadItem): void {
    const threads = item.type === "subAgentActivity" && item.kind === "started" ? [item.agentThreadId]
      : item.type === "collabAgentToolCall" && item.tool === "spawnAgent" ? item.receiverThreadIds
      : []
    for (const agent of threads) if (!this.agents.has(agent)) this.agents.set(agent, undefined)
  }

  /**
   * A notification of an agent this thread spawned: the agents it spawns in
   * turn, and what it spends, which the conversation's meter counts as the
   * agent reports it. An agent's first reading is its first call; each later
   * one adds what its total grew by.
   */
  private agentNotification(out: CodexDecoded[], agent: string, notification: ProtocolNotification): void {
    if (notification.method === "item/started" || notification.method === "item/completed") return this.spawned(notification.item)
    if (notification.method !== "thread/tokenUsage/updated" || !notification.total) return
    const before = this.agents.get(agent)
    this.agents.set(agent, notification.total)
    const spent = before ? tokensSince(before, notification.total) : notification.call ?? notification.total
    if (!spent || contextOf(spent) <= 0) return
    const usage = this.meter.observe({ kind: "spent", tokens: spent })
    if (usage) out.push(decoded.state({ usage }))
  }

  private notification(out: CodexDecoded[], notification: ProtocolNotification, raw: JsonObject): void {
    if (notification.method === "invalid") {
      out.push(decoded.unknown(notification.kind, raw, "unreadable"))
      return
    }
    const thread = this.view.threadId
    if (notification.threadId && thread && notification.threadId !== thread) {
      if (this.agents.has(notification.threadId)) this.agentNotification(out, notification.threadId, notification)
      if (notification.method === "turn/started" || notification.method === "turn/completed")
        out.push(decoded.effect({ type: "subagent-turn", threadId: notification.threadId, completed: notification.method === "turn/completed" }))
      if (notification.method === "item/started" && notification.item.type === "commandExecution")
        out.push(decoded.effect({ type: "command-started", threadId: notification.threadId, turnId: notification.turnId, itemId: notification.item.id, processId: notification.item.processId }))
      return
    }
    switch (notification.method) {
      case "turn/started":
        this.currentTurnId = notification.turnId
        this.goalTurnId = null
        this.waiting = undefined
        if (this.expectingTurn) this.expectingTurn = false
        else if (this.goal) this.goalTurnId = notification.turnId
        out.push(
          decoded.effect({ type: "turn-started", turnId: notification.turnId }),
          decoded.state({ status: "running", nativeRunId: notification.turnId, error: undefined }),
        )
        this.announce(out, notification.turnId)
        return
      case "turn/completed":
        this.completeTurn(out, notification.turn)
        return
      case "thread/goal/updated":
        this.goal = notification.goal.status === "active" ? notification.goal : null
        out.push(decoded.goal(codexGoalObservation(notification.goal)))
        return
      case "thread/goal/cleared":
        this.goal = null
        out.push(decoded.goal(null))
        return
      case "item/started":
      case "item/completed":
        this.item(out, notification.turnId, notification.item, notification.method === "item/completed")
        return
      case "item/agentMessage/delta":
        this.streamDelta(out, notification, "text")
        return
      case "item/plan/delta": {
        const id = `codex:${notification.turnId}:${notification.itemId}`
        if (!this.landed.has(id)) out.push(decoded.update({ kind: "proposed-plan", id, text: notification.delta, status: "drafting" }))
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
        const { used, size, total, call, turnId } = notification
        const observations: UsageObservation[] = [{ kind: "context", used, size }]
        const spent = total && this.threadSpend(total, turnId === this.currentTurnId ? call : undefined)
        if (spent && contextOf(spent) > 0) observations.push({ kind: "spent", tokens: spent })
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
        if (notification.method === "warning" && onlyMakoFeatures(notification.message)) return
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
        // Codex joins summary parts with a blank line, as its record does.
        if (notification.summaryIndex > 0)
          this.streamDelta(out, { ...notification, method: "item/reasoning/summaryTextDelta", delta: "\n\n" }, "thinking")
        return
      case "item/fileChange/patchUpdated":
      case "turn/plan/updated":
        return
    }
  }

  private completeTurn(out: CodexDecoded[], turn: Turn): void {
    const error = turn.error?.message || undefined
    const stop = turn.status === "inProgress" ? "completed" : turn.status
    this.currentTurnId = null
    this.goalTurnId = null
    this.waiting = undefined
    // Codex ends a stopped turn without finishing the cell calls it stopped.
    for (const id of this.running) if (stop === "interrupted") out.push(decoded.update({ kind: "tool-update", id, status: "canceled" }))
    this.running.clear()
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

  /** Text Codex is still streaming, under the id its record will draw it with. */
  private streamDelta(out: CodexDecoded[], notification: StreamDeltaNotification, kind: "text" | "thinking"): void {
    if (!notification.turnId || !notification.itemId || !notification.delta) return
    // Output arriving is the response passing its check; Codex sends no end.
    if (this.waiting === CHECKING_RESPONSE) this.endWait(out, CHECKING_RESPONSE)
    if (this.landed.has(notification.itemId)) return
    out.push(decoded.update({ kind, id: notification.itemId, text: notification.delta }))
  }

  /** Output a running call is printing, on the row its call's record drew. */
  private streamToolOutput(out: CodexDecoded[], notification: ToolOutputNotification): void {
    if (!notification.delta || !notification.turnId || !notification.itemId || this.landed.has(notification.itemId)) return
    out.push(decoded.update({ kind: "tool-update", id: notification.itemId, outputAppend: notification.delta }))
  }

  /**
   * An item's start or end. Its content is its record's; what is left are
   * the facts the driver acts on, a call with no record until it ends (a
   * code cell's, a web search) while it runs, and compacting while Codex
   * compacts.
   */
  private item(out: CodexDecoded[], turnId: string, item: ThreadItem, completed: boolean): void {
    if (!turnId) return
    if (this.waiting === CHECKING_RESPONSE) this.endWait(out, CHECKING_RESPONSE)
    const thread = this.view.threadId
    switch (item.type) {
      case "userMessage": {
        if (!completed || !thread) return
        const text = item.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n")
        for (const answer of codexAnsweredQuestions(thread, text)) out.push(decoded.effect({ type: "question-answer", answer }))
        return
      }
      case "agentMessage":
        if (completed && item.questions && thread)
          out.push(decoded.effect({ type: "question", question: codexAsyncQuestion(thread, turnId, item.id, item.questions) }))
        return
      case "commandExecution":
        if (!completed) {
          if (thread) out.push(decoded.effect({ type: "command-started", threadId: thread, turnId, itemId: item.id, processId: item.processId }))
          const command = codexCommand(item.command)
          this.runningCall(out, item.id, { kind: "tool", id: item.id, title: firstLine(command) || "Command", name: "exec_command", status: "pending", input: JSON.stringify({ command }) })
        } else out.push(decoded.effect({ type: "command-ended", itemId: item.id }))
        return
      case "mcpToolCall":
        if (!completed)
          this.runningCall(out, item.id, { kind: "tool", id: item.id, title: `${item.server}: ${item.tool}`, name: `mcp__${item.server}__${item.tool}`, status: "pending",
            ...item.arguments !== undefined && item.arguments !== null && { input: JSON.stringify(item.arguments, null, 2) } })
        return
      case "webSearch":
        // Its record lands when the search ends.
        if (!completed)
          this.runningCall(out, item.id, { kind: "tool", id: item.id, title: item.query || "Web search", name: "web_search", status: "pending", input: JSON.stringify(item.action ?? { query: item.query }) })
        return
      case "collabAgentToolCall":
      case "subAgentActivity":
        this.spawned(item)
        out.push(decoded.effect({ type: "agents", item, replay: false, toolId: item.id }))
        return
      case "contextCompaction":
        if (completed) out.push(decoded.effect({ type: "compaction-item", turnId }))
        else {
          this.waiting = undefined
          out.push(decoded.activity({ kind: "compacting" }))
        }
        return
      case "unsupported":
        out.push(decoded.unknown(`item/${item.sourceType}`, { type: item.sourceType, id: item.id }))
        return
      default:
        return
    }
  }

  /** A call Codex runs before any record names it: a code cell's, until the cell's record of it lands. */
  private runningCall(out: CodexDecoded[], id: string, update: LiveUpdate): void {
    if (this.calls.has(id) || this.running.has(id)) return
    this.running.add(id)
    out.push(decoded.update(update))
  }
}

/** A call's whole row as an update of the row already drawn, which a turn that doesn't hold it ignores. */
function finishing(update: Extract<LiveUpdate, { kind: "tool" }>): LiveUpdate {
  const row: LiveUpdate = { kind: "tool-update", id: update.id, title: update.title, status: update.status }
  if (update.input !== undefined) row.input = update.input
  if (update.output !== undefined) row.output = update.output
  if (update.details) row.details = update.details
  if (update.attachments) row.attachments = update.attachments
  if (update.effects) row.effects = update.effects
  return row
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

const UNSTABLE_FEATURES = /^Under-development features enabled: ([\w, ]+)\./
const MAKO_FEATURES = new Set(Object.keys(codexInteractiveConfig()).flatMap((key) => key.startsWith("features.") ? [key.slice("features.".length)] : []))

/** Codex's warning about unstable features, when it names only those Mako's thread config turns on: the person chose none of them. */
function onlyMakoFeatures(message: string): boolean {
  const listed = UNSTABLE_FEATURES.exec(message)?.[1]?.split(",").map((name) => name.trim())
  return Boolean(listed?.length && listed.every((name) => MAKO_FEATURES.has(name)))
}

/** A variant Mako has no words for yet, as lowercase words. */
function words(identifier: string): string {
  return identifier.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()
}

/** FNV-1a: a short, stable name for a notice's text. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193)
  return (hash >>> 0).toString(16).padStart(8, "0")
}

