import { cursorSdkReportedSettings } from "@mako/sessions"
import type { SessionModel, SettingValue } from "@mako/sessions/settings"
import type { Decoded } from "../../../contracts/native-decoding.js"
import type { NativeAgentObservation } from "../../../contracts/native-agents.js"
import type { LiveSessionState } from "../../../shared.js"
import { fromInclusiveCounts, SessionUsage } from "../../../session-usage.js"
import { CursorAgents } from "./agents.js"
import { compactionSummary, CursorSdkProjection } from "./projection.js"
import type { SdkDelta, SdkEvent, SdkMessage, SdkModelSelection } from "./wire.js"

/** The selected model's options, with the values `selection` sets as their current ones. */
export function cursorConfigOptions(
  models: readonly SessionModel[],
  selection: SdkModelSelection | undefined,
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

export type CursorTurnOutcome = "finished" | "cancelled" | "error"

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
      ? this.message(event.message, event.seq === undefined ? undefined : `${event.turn}:${event.seq}`)
      : this.delta(event.delta)
  }

  /** Ends the turn's projection, closing any tool row the run left open with `note`. */
  finish(outcome: CursorTurnOutcome, note: string): Decoded<CursorEffect>[] {
    const decoded = this.releaseCompaction()
    const projection = this.projection
    this.projection = null
    if (projection) decoded.push(...projection.finish(outcome, note).map((update) => ({ kind: "update" as const, update })))
    return decoded
  }

  private message(message: SdkMessage, source: string | undefined): Decoded<CursorEffect>[] {
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
      // The turn's spend only: SDK 1.0.31 sums the turn's model calls and names no window, so it says nothing about how full the context is.
      const usage = this.meter.observe({ kind: "spent", tokens: fromInclusiveCounts({
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
      decoded.push({ kind: "compacted", compaction: { summary }, source })
      this.compaction = this.compaction === "awaiting-summary" ? "idle" : "marked"
    }
    const agent = this.agents.project(message)
    if (agent) decoded.push({ kind: "effect", effect: { type: "agent", agent } })
    return decoded
  }

  private delta(delta: SdkDelta): Decoded<CursorEffect>[] {
    const decoded: Decoded<CursorEffect>[] = this.projection!.delta(delta).map((update) => ({ kind: "update", update }))
    switch (delta.type) {
      case "summary-started":
        decoded.push(...this.releaseCompaction(), { kind: "activity", activity: { kind: "compacting" } })
        break
      case "summary-completed":
        if (this.compaction === "marked") this.compaction = "idle"
        else {
          this.compaction = "awaiting-summary"
          decoded.push({ kind: "activity", activity: null })
        }
        break
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
