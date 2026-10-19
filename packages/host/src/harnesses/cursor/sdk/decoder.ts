import { cursorSdkReportedSettings } from "@mako/sessions"
import type { SessionModel, SettingValue } from "@mako/sessions/settings"
import type { Decoded } from "../../../contracts/native-decoding.js"
import type { Compaction } from "@mako/sessions/events"
import type { NativeAgentObservation } from "../../../contracts/native-agents.js"
import type { ContextBreakdown, LiveSessionState } from "../../../contracts/providers-acp.js"
import { inclusiveTokens } from "@mako/sessions/harnesses"
import { SessionUsage } from "../../session-usage.js"
import {
  compactionSummary,
  cursorSdkMessageRecord,
  CursorSdkProjection,
  type CursorSdkDelta,
  type CursorSdkMessage,
  type CursorSdkModelSelection,
  type CursorTurnOutcome,
} from "@mako/sessions/cursor-sdk-content"
import { CursorAgents } from "./agents.js"
import type { SdkEvent, SdkSettledCalls } from "./wire.js"

function settledResults(calls: SdkSettledCalls): Map<string, { output: string; failed: boolean }> {
  return new Map(calls.map(({ callId, ...result }) => [callId, result]))
}

/** The selected model's options, with the values `selection` sets as their current ones. */
export function cursorConfigOptions(
  models: readonly SessionModel[],
  selection: CursorSdkModelSelection | undefined,
  plan?: SettingValue
): SessionModel["options"] {
  if (!selection) return []
  const model = models.find((candidate) => candidate.id === selection.id)
  if (!model) return []
  const reported = cursorSdkReportedSettings(selection, models, plan)
  return model.options.map((option) => {
    const value = reported.options?.[option.id]
    if (value === undefined) return option
    if (option.kind === "select" && value !== true && value !== false) return { ...option, current: value }
    if (option.kind === "boolean" && (value === true || value === false)) return { ...option, current: value }
    return option
  })
}

/** Cursor's own facts the driver acts on beyond the transcript. */
export type CursorEffect = { type: "agent"; agent: NativeAgentObservation }

/** What the decoder reads from the live session: the account's models and the plan setting. */
export interface CursorDecoderView {
  readonly models: SessionModel[]
  readonly state: Pick<LiveSessionState, "settings">
}

/**
 * Where the current compaction's marker stands. The summary (a `task`
 * message) and `summary-completed` (a delta) travel separately and may
 * arrive in either order: the summary always places the marker, and a
 * completion seen first holds it until the summary or the turn's end.
 */
type CompactionMark = "idle" | "awaiting-summary" | "marked"

/**
 * Cursor's child events as Mako's decoded events, one turn at a time. The
 * driver decides which turn a line belongs to and when a turn starts and
 * ends; this owns what the lines say.
 */
export class CursorDecoder {
  private projection: CursorSdkProjection | null = null
  private compaction: CompactionMark = "idle"
  private readonly agents = new CursorAgents()
  private readonly meter = new SessionUsage()
  /** What fills the context, as the reading the meter shows itemizes it; gone with a compaction. */
  private itemized: ContextBreakdown | undefined
  /**
   * The newest summary whose marker waits for what it left: the agent's
   * next reading that isn't the one from before, in this run or a later
   * one, until a newer summary takes its place.
   */
  private measuring: { window: string; compaction: Compaction } | undefined
  private readonly view: CursorDecoderView

  constructor(view: CursorDecoderView) {
    this.view = view
  }

  /** A turn is open to decode lines into. */
  get open(): boolean {
    return this.projection !== null
  }

  startTurn(turn: string): void {
    this.projection = new CursorSdkProjection(turn)
  }

  decode(event: Extract<SdkEvent, { event: "message" | "delta" }>): Decoded<CursorEffect>[] {
    if (!this.projection) return []
    return event.event === "message"
      ? this.message(event.message, event.seq === undefined ? undefined : cursorSdkMessageRecord(event.message, event.seq))
      : this.delta(event.delta)
  }

  /**
   * The context as Cursor's latest checkpoint measured it: the last model
   * call's input and output, of the model's window. Read whether or not a
   * turn is open, since a stopped run's last checkpoint can land after its
   * result and an opening agent's comes before any turn.
   */
  context(event: Extract<SdkEvent, { event: "context" }>): Decoded<CursorEffect>[] {
    this.itemized = event.categories?.length ? {
      used: event.used,
      size: event.size,
      categories: event.categories.map((category) => ({ name: category.label, tokens: category.tokens, kind: "used" as const })),
      items: [],
    } : undefined
    const decoded: Decoded<CursorEffect>[] = []
    const measuring = this.measuring
    const stale = measuring !== undefined && event.used === measuring.compaction.tokensBefore
    if (measuring && !stale) {
      // What the summary left, in the unit of the meter: the call after it, input and output, as Codex's `tokensAfter`.
      this.measuring = undefined
      decoded.push(this.completion(measuring.window, { ...measuring.compaction, tokensAfter: event.used }))
    }
    // The root a reopened agent stands at may still repeat the reading from before its summary: that holds nothing now.
    const usage = stale
      ? this.meter.observe({ kind: "context", used: event.used, size: event.size }, { kind: "compacted" })
      : this.meter.observe({ kind: "context", used: event.used, size: event.size })
    if (usage) decoded.push({ kind: "state", patch: { usage } })
    return decoded
  }

  /**
   * A summary Cursor made on its server, seen only as a window its latest
   * checkpoint archived: marked where it happened, citing the window as the
   * saved history does, with what the context held before. What it left is
   * the next reading's.
   */
  archived(event: Extract<SdkEvent, { event: "compaction" }>): Decoded<CursorEffect>[] {
    const compaction: Compaction = { ...event.summary !== undefined && { summary: event.summary }, ...event.tokensBefore !== undefined && { tokensBefore: event.tokensBefore } }
    if (event.drawn) {
      // An earlier child drew it: completed now if a root since measured it, else by the next reading.
      if (event.tokensAfter !== undefined) return [this.completion(event.window, { ...compaction, tokensAfter: event.tokensAfter })]
      this.measuring = { window: event.window, compaction }
      return []
    }
    this.itemized = undefined
    // Completed by the agent's next reading (`context`); a newer summary leaves this one unmeasured.
    this.measuring = { window: event.window, compaction }
    const decoded: Decoded<CursorEffect>[] = [{ kind: "compacted", compaction, source: event.window }]
    const usage = this.meter.observe({ kind: "compacted" })
    if (usage) decoded.push({ kind: "state", patch: { usage } })
    return decoded
  }

  /** The marker drawn under `window`, completed with what its summary left. */
  private completion(window: string, compaction: Compaction): Decoded<CursorEffect> {
    return { kind: "compacted", compaction, source: window, completes: true }
  }

  /** The latest reading's categories, for the meter's popover. */
  get breakdown(): ContextBreakdown | undefined {
    return this.itemized
  }

  /** Ends calls the run moved past, with what a checkpoint saved since kept for them. */
  settle(calls: SdkSettledCalls): Decoded<CursorEffect>[] {
    if (!this.projection) return []
    return this.projection.settle(settledResults(calls)).map((update) => ({ kind: "update", update }))
  }

  /** Ends the turn's projection, closing any tool row the run left open with what its checkpoint kept (`settled`), else `note`. */
  finish(outcome: CursorTurnOutcome, note: string, settled?: SdkSettledCalls): Decoded<CursorEffect>[] {
    const decoded = this.releaseCompaction()
    const projection = this.projection
    this.projection = null
    const results = settledResults(settled ?? [])
    if (projection) decoded.push(...projection.finish(outcome, note, () => results).map((update) => ({ kind: "update" as const, update })))
    return decoded
  }

  private message(message: CursorSdkMessage, source: string | undefined): Decoded<CursorEffect>[] {
    const decoded: Decoded<CursorEffect>[] = []
    if (message.type === "system" && message.model) {
      const plan = this.view.state.settings?.options?.plan
      decoded.push({
        kind: "state",
        patch: {
          settings: cursorSdkReportedSettings(message.model, this.view.models, plan),
          configOptions: cursorConfigOptions(this.view.models, message.model, plan),
        },
      })
    }
    for (const update of this.projection!.message(message)) decoded.push({ kind: "update", update })
    if (message.type === "usage") {
      // The turn's spend only: SDK 1.0.31 sums the turn's model calls, so how full the context is comes from each checkpoint (`context`).
      const usage = this.meter.observe({ kind: "spent", tokens: inclusiveTokens({
        input: message.usage.inputTokens,
        cacheRead: message.usage.cacheReadTokens,
        cacheWrite: message.usage.cacheWriteTokens,
        output: message.usage.outputTokens,
        reasoning: message.usage.reasoningTokens,
      }) })
      if (usage) decoded.push({ kind: "state", patch: { usage } })
    }
    const summary = compactionSummary(message)
    if (summary) {
      const before = this.meter.context
      decoded.push({ kind: "compacted", compaction: { summary, ...before !== undefined && { tokensBefore: before } }, source })
      this.compaction = this.compaction === "awaiting-summary" ? "idle" : "marked"
    }
    const agent = this.agents.project(message)
    if (agent) decoded.push({ kind: "effect", effect: { type: "agent", agent } })
    return decoded
  }

  private delta(delta: CursorSdkDelta): Decoded<CursorEffect>[] {
    const decoded: Decoded<CursorEffect>[] = this.projection!.delta(delta).map((update) => ({ kind: "update", update }))
    switch (delta.type) {
      case "summary-started": {
        decoded.push(...this.releaseCompaction(), { kind: "activity", activity: { kind: "compacting" } })
        // Cursor says nothing of what the summary leaves until the checkpoint after the next model call.
        this.itemized = undefined
        const usage = this.meter.observe({ kind: "compacted" })
        if (usage) decoded.push({ kind: "state", patch: { usage } })
        break
      }
      case "summary-completed":
        if (this.compaction === "marked") this.compaction = "idle"
        else {
          this.compaction = "awaiting-summary"
          decoded.push({ kind: "activity", activity: null })
        }
        break
      case "subagent-call": {
        const agent = this.agents.progress(delta)
        if (agent) decoded.push({ kind: "effect", effect: { type: "agent", agent } })
        break
      }
      case "unhandled":
        decoded.push({ kind: "unknown", type: delta.kind, reason: "unknown", raw: { type: "unhandled", kind: delta.kind } })
        break
    }
    return decoded
  }

  /** A completed compaction whose summary never came is still marked. */
  private releaseCompaction(): Decoded<CursorEffect>[] {
    const decoded: Decoded<CursorEffect>[] = this.compaction === "awaiting-summary" ? [{ kind: "compacted" }] : []
    this.compaction = "idle"
    return decoded
  }
}
