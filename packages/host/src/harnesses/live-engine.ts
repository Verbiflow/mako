import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type {
  ApprovalSubmission,
  ApprovalEndSource,
} from "../contracts/approval-response.js"
import type { LiveDriverEvent } from "../contracts/live-conversations.js"
import type { LivePermissionRequest, LivePermissionResponse, LiveSessionState } from "../contracts/providers-acp.js"
import { liveToolFinished, type LiveUpdate } from "@mako/sessions/live-content"
import type { NativeActivityObservation, NativeNotice } from "../contracts/native-activity.js"
import type { NativeAgentObservation } from "../contracts/native-agents.js"
import {
  compactionEvent,
  retriesEvent,
  type Compaction,
  type Retries,
  type TranscriptEvent,
} from "@mako/sessions/events"
import type { JsonValue } from "../contracts/json.js"
import {
  decodedNotices,
  type DecodedSink,
} from "../contracts/native-decoding.js"
import { retainUndeclaredTools, retainUnknown, type UnknownReason, type UnknownSeen } from "../base/native-unknown.js"
import { topic } from "../base/topic.js"
import { frameOf, frameTime } from "./native-stream.js"
import { liveEffectsStatus } from "@mako/sessions/tool-effect-reading"
import type { ToolEffects } from "@mako/sessions/tool-effects"

/** What a live engine's per-session record must carry to share the runtime. */
export interface EngineLive {
  state: LiveSessionState
  emit(event: LiveDriverEvent): void
  /** Present when the engine answers requests through a pending map. */
  pendingPermissions?: Map<
    string,
    (response: LivePermissionResponse, ended?: ApprovalEndSource) => void
  >
}

/** Sessions whose permission requests resolve through a pending map. */
export interface PermittingLive extends EngineLive {
  pendingPermissions: Map<
    string,
    (response: LivePermissionResponse, ended?: ApprovalEndSource) => void
  >
}

export interface LiveEngineApi<Live extends EngineLive> {
  sessions: Map<string, Live>
  state(id: string): LiveSessionState | null
  /** Patch the session's state and report the new whole. */
  patch(live: Live, patch: Partial<LiveSessionState>): void
  emitUpdate(live: Live, update: LiveUpdate): void
  emitUpdates(live: Live, updates: LiveUpdate[]): void
  emitAgent(live: Live, agent: NativeAgentObservation): void
  /** What the turn is doing without output, or `null` once it stops. */
  activity(live: Live, activity: NativeActivityObservation | null): void
  /**
   * The provider compacted the conversation: the transcript marks it and
   * compacting ends. Without a duration from the provider, the marker says
   * how long it took since the provider said it was compacting.
   */
  compacted(live: Live, compaction?: Compaction, id?: string, completes?: boolean): void
  /**
   * A marker in the transcript: a provider notice, warning or failure. `id`
   * names the native event, so the same event replayed is drawn once.
   */
  event(live: Live, event: TranscriptEvent, id?: string): void
  /**
   * Apply what a harness decoder made of one native event; `undefined`
   * means the decoder does not know it, and `kind` is logged as unhandled.
   * `source` is the native event's own id, which names its markers.
   */
  observe(
    live: Live,
    kind: string,
    notices: readonly NativeNotice[] | undefined,
    source?: string
  ): void
  /**
   * A native event this engine does not translate. Logged once per harness
   * and kind for the host's life, so a new provider event is on record
   * without a line per occurrence.
   */
  unhandled(live: Live, kind: string): void
  /** Like `unhandled`, keeping the first raw record of each kind (`native-unknown.ts`). */
  unknown(live: Live, kind: string, reason: UnknownReason, raw: JsonValue): void
  /**
   * Where a harness decoder's events go for this session. `effect` takes
   * the harness's own facts; `usage` the plan-limit windows it reported.
   */
  sink<Effect>(
    live: Live,
    handlers: {
      effect(effect: Effect): void
      usage?(windows: import("../contracts/accounts.js").UsageWindow[]): void
    }
  ): DecodedSink<Effect>
  /**
   * Put a request to the desk and wait for its answer. The pending entry
   * is removed when the answer arrives; `release` answers whatever is
   * left when the session stops.
   */
  ask(
    live: PermittingLive,
    request: LivePermissionRequest
  ): Promise<LivePermissionResponse>
  respondPermission(
    id: string,
    requestId: string,
    response: LivePermissionResponse
  ): ApprovalSubmission
  /** Every request a stopping session leaves behind gets no choice. */
  release(live: PermittingLive): void
}

/**
 * The bookkeeping every live engine re-implemented four times: the sessions
 * map keyed by conversation id, state patching with the `live-session`
 * report, the event vocabulary, and permission-request routing. An engine
 * keeps only protocol translation — turning session/new, turn/start, or SDK
 * callbacks into these calls.
 */
/**
 * How long after compacting stops its completion still belongs to it. Cursor
 * ends the activity before its summary arrives; a completion much later is
 * another compaction whose start went unreported.
 */
const COMPACTION_LINGER_MS = 60_000

/** Marker ids remembered per conversation to drop a replayed event; far more than a turn draws. */
const MAX_DRAWN_MARKERS = 512

/** A compaction as first drawn, with what a later statement of it adds; nothing it said is taken back. */
function completedCompaction(known: Compaction, next: Compaction): Compaction {
  const completed: Compaction = { ...known }
  if (next.trigger !== undefined) completed.trigger = next.trigger
  if (next.tokensBefore !== undefined) completed.tokensBefore = next.tokensBefore
  if (next.tokensAfter !== undefined) completed.tokensAfter = next.tokensAfter
  if (next.summary !== undefined) completed.summary = next.summary
  if (next.durationMs !== undefined) completed.durationMs = next.durationMs
  return completed
}

/**
 * An update as it leaves the engine: a turn the provider started stamped
 * with the moment the host received it, and each update with the stream
 * frame it was decoded from (`withFrame`). Every harness's driver and
 * decoder emits through the engine, and the decoders are pure, so this is
 * the one place the time is read; the reducer and the window's projection
 * only carry it.
 */
function stamped(update: LiveUpdate): LiveUpdate {
  if (update.kind === "retract") return update
  const frame = update.stream ? undefined : frameOf()
  if (update.kind === "provider-turn" && update.at === undefined) return frame ? { ...update, at: Date.now(), stream: frame } : { ...update, at: Date.now() }
  return frame ? { ...update, stream: frame } : update
}

/** Calls whose start and end are stamped, per conversation; far more than run at once. */
const MAX_TIMED_CALLS = 4096

/**
 * A tool update with when the host first saw its call and first saw it
 * finished. Each is stamped once per call, so the output a finished call
 * still streams stays an append in storage.
 */
function timed(calls: Map<string, { at: number; ended: boolean }>, update: LiveUpdate): LiveUpdate {
  if (update.kind !== "tool" && update.kind !== "tool-update") return update
  let call = calls.get(update.id)
  if (!call) {
    if (update.kind === "tool-update") return update
    call = { at: update.at ?? clock(), ended: false }
    calls.set(update.id, call)
    if (calls.size > MAX_TIMED_CALLS) calls.delete(calls.keys().next().value!)
  }
  const ends = !call.ended && liveToolFinished(update.status)
  if (ends) call.ended = true
  if (update.kind === "tool") return { ...update, at: call.at, ...(ends && { endedAt: update.endedAt ?? clock() }) }
  return ends ? { ...update, endedAt: update.endedAt ?? clock() } : update
}

/**
 * What each finished tool call reported doing, as the live engine hands it
 * on: the call (`ToolEffects`, from `@mako/sessions/tool-effects`) and the
 * conversation it belongs to.
 *
 * Every harness's decoder puts a finished call's effects on the update that
 * ends it (`effects` on a `tool`/`tool-update`), read by the same code its
 * history reader runs, so the effects a live call reports here are the ones
 * `savedToolEffects` (`@mako/sessions/tool-effect-reading`) reads back from
 * the saved session. The engine is where they leave the decoders: it stamps
 * when the host saw the call start and end and calls `LiveEngineHooks.effects`,
 * which by default publishes on `mako:tool-effects` (`liveToolEffects`); with
 * no subscriber that costs a property read. A session the harness replays on
 * resume reports its finished calls again under the same call ids, so a
 * consumer keys what it keeps by conversation and call id.
 */
export interface LiveToolEffects {
  /** The live conversation's id. */
  conversation: string
  harness: string
  nativeId?: string
  /** The folder the session runs in; each effect's paths are already absolute. */
  cwd: string
  call: ToolEffects
}

export const liveToolEffects = topic<LiveToolEffects>("mako:tool-effects")

/** What an engine hands on besides the session's events. */
export interface LiveEngineHooks<Live extends EngineLive> {
  /** Each finished call's effects; the default publishes them on `liveToolEffects`. */
  effects?(live: Live, call: ToolEffects): void
}

function publishEffects(live: EngineLive, call: ToolEffects): void {
  if (!liveToolEffects.heard) return
  const { id, harness, nativeId, cwd } = live.state
  liveToolEffects.publish({ conversation: id, harness, ...nativeId && { nativeId }, cwd, call })
}

/** Calls whose start is remembered per conversation; far more than run at once. */
const MAX_STARTED_CALLS = 1024

/**
 * The time a compaction is measured by: when the frame being decoded
 * arrived, as the stream stamped it, so a replay of the stream measures
 * what the host did; the host's clock for what no frame carries (a turn
 * the driver ended).
 */
const clock = (): number => frameTime() ?? Date.now()

/** When the provider last said it was compacting, and when it stopped saying so. */
interface Compacting {
  since: number
  until?: number
}

/** A provider's retries of the model while they last: since its first retry notice, and how many it made. */
interface Retrying {
  since: number
  count: number
  /** The attempt the last notice numbered: a notice that says the same attempt again counts once. */
  attempt?: number
  /** The provider's words for what failed, as its last notice gave them. */
  reason?: string
}

/** The model answering: what ends a provider's retries as recovered. */
function answers(update: LiveUpdate): boolean {
  switch (update.kind) {
    case "text":
    case "thinking":
      return update.text.length > 0
    case "tool":
    case "proposed-plan":
    case "plan":
      return true
    default:
      return false
  }
}

/** Whether the failure's own words already say `reason`, so the retries' line leaves it to them. */
function said(reason: string, failure: readonly (string | undefined)[]): boolean {
  const words = reason.trim().toLowerCase()
  return failure.some((text) => text?.toLowerCase().includes(words))
}

export function createLiveEngine<
  Live extends EngineLive,
>(hooks: LiveEngineHooks<Live> = {}): LiveEngineApi<Live> {
  const sessions = new Map<string, Live>()
  const handEffects = hooks.effects ?? publishEffects
  /** When the host first saw each call of a conversation, until it ends. */
  const started = new WeakMap<Live, Map<string, number>>()
  const observeCalls = (live: Live, updates: readonly LiveUpdate[]): void => {
    for (const update of updates) {
      if (update.kind !== "tool" && update.kind !== "tool-update") continue
      let calls = started.get(live)
      if (!calls) started.set(live, (calls = new Map()))
      if (update.kind === "tool" && !calls.has(update.id)) {
        calls.set(update.id, Date.now())
        if (calls.size > MAX_STARTED_CALLS) calls.delete(calls.keys().next().value!)
      }
      if (!update.effects || !update.status) continue
      const call: ToolEffects = {
        callId: update.id,
        status: liveEffectsStatus(live.state.harness, { status: update.status, output: update.output }),
        effects: update.effects,
        endedAt: Date.now(),
      }
      const since = calls.get(update.id)
      if (since !== undefined) call.startedAt = since
      calls.delete(update.id)
      handEffects(live, call)
    }
  }
  const compacting = new WeakMap<Live, Compacting>()
  /**
   * The provider's retries in progress. They end in one quiet marker:
   * recovered, when the model answers; given up, when the provider reports
   * the failure (an error marker, or an error in its state), which says the
   * failure itself, so the marker keeps only words the failure doesn't. A turn that ends any other
   * way (a Stop, a process gone) ends them unsaid, its own ending says why.
   * Every end but the turn's is decoded from the harness's own messages and
   * measured by the frames' clock, so a replay of the stream draws what the
   * window drew.
   */
  const retrying = new WeakMap<Live, Retrying>()
  const retried = (live: Live, observation: Extract<NativeActivityObservation, { kind: "retrying" }>): void => {
    const held = retrying.get(live)
    const reason = observation.reason ?? held?.reason
    const repeated = held !== undefined && observation.attempt !== undefined && observation.attempt === held.attempt
    const next: Retrying = { since: held?.since ?? clock(), count: (held?.count ?? 0) + (repeated ? 0 : 1) }
    if (observation.attempt !== undefined) next.attempt = observation.attempt
    if (reason) next.reason = reason
    retrying.set(live, next)
  }
  /** `failure`: the words of what the provider gave up on, which say the failure once; the retries' line doesn't repeat them. */
  const endRetries = (live: Live, outcome: Retries["outcome"] | undefined, failure: readonly (string | undefined)[] = []): void => {
    const held = retrying.get(live)
    if (!held) return
    retrying.delete(live)
    if (!outcome) return
    const retries: Retries = { count: held.count, outcome, durationMs: Math.max(0, Math.round(clock() - held.since)) }
    drawEvent(live, retriesEvent(retries, held.reason && !said(held.reason, failure) ? held.reason : undefined))
  }
  /** Compacting stops when the provider reports something else, or its turn ends; a retry is part of it. */
  const stopCompacting = (live: Live): void => {
    const held = compacting.get(live)
    if (held && held.until === undefined) held.until = clock()
  }
  const activity = (
    live: Live,
    observation: NativeActivityObservation | null
  ): void => {
    const held = compacting.get(live)
    if (observation?.kind === "compacting") {
      if (!held || held.until !== undefined)
        compacting.set(live, { since: clock() })
    } else if (observation?.kind !== "retrying") stopCompacting(live)
    if (observation?.kind === "retrying") retried(live, observation)
    live.emit({
      type: "live-activity",
      id: live.state.id,
      activity: observation,
    })
  }
  const drawn = new WeakMap<Live, Set<string>>()
  /** Whether this native event already has its marker; the first one drawn stands. */
  const repeated = (live: Live, id: string): boolean => {
    let ids = drawn.get(live)
    if (!ids) drawn.set(live, (ids = new Set()))
    if (ids.has(id)) return true
    ids.add(id)
    if (ids.size > MAX_DRAWN_MARKERS) ids.delete(ids.values().next().value!)
    return false
  }
  const event = (live: Live, marker: TranscriptEvent, id?: string): void => {
    if (id && repeated(live, id)) return
    // The failure a provider retried and gave up on: its retries are summed up before it.
    if (marker.tone === "error" || marker.limit) endRetries(live, "gave-up", [marker.label, marker.detail, marker.body])
    drawEvent(live, marker, id)
  }
  const drawEvent = (live: Live, marker: TranscriptEvent, id?: string, completes = false): void => {
    const update: LiveUpdate = id
      ? {
          kind: "event",
          ...marker,
          id,
          ...completes && { completes: true as const },
          source: marker.source ?? { harness: live.state.harness, record: id },
        }
      : { kind: "event", ...marker }
    live.emit({ type: "live-update", id: live.state.id, update: stamped(update) })
  }
  /** Each compaction drawn under an id, so a harness that measures what it left later can complete its marker. */
  const compactions = new WeakMap<Live, Map<string, Compaction>>()
  const compacted = (
    live: Live,
    compaction?: Compaction,
    id?: string,
    completes = false
  ): void => {
    const known = id === undefined ? undefined : compactions.get(live)?.get(id)
    if (id !== undefined && (known || completes)) {
      // The same compaction again completes its marker in place, in an
      // earlier turn too (the reducer finds a `completes` event by its id
      // anywhere): what it adds is drawn, and a replay that adds nothing
      // changes nothing.
      const completed = completedCompaction(known ?? {}, compaction ?? {})
      if (known && isDeepStrictEqual(completed, known)) return
      keepCompaction(live, id, completed)
      drawEvent(live, compactionEvent(completed), id, true)
      return
    }
    const held = compacting.get(live)
    compacting.delete(live)
    const now = clock()
    const until = held?.until ?? now
    const measured =
      held &&
      compaction?.durationMs === undefined &&
      now - until < COMPACTION_LINGER_MS
        ? { ...compaction, durationMs: until - held.since }
        : compaction
    if (id !== undefined && !drawn.get(live)?.has(id)) keepCompaction(live, id, measured ?? {})
    event(live, compactionEvent(measured), id)
    activity(live, null)
  }
  const keepCompaction = (live: Live, id: string, compaction: Compaction): void => {
    let kept = compactions.get(live)
    if (!kept) compactions.set(live, (kept = new Map()))
    kept.delete(id)
    kept.set(id, compaction)
    if (kept.size > MAX_DRAWN_MARKERS) kept.delete(kept.keys().next().value!)
  }
  /**
   * Patch the session's state and report the new whole. A field restated
   * with what it already holds keeps its value: the window is sent only
   * fields whose values changed (`sessionDelta`), and an agent restates its
   * whole option list every turn (Devin's is tens of kilobytes).
   */
  const patch = (live: Live, change: Partial<LiveSessionState>): void => {
    if (change.status !== undefined && change.status !== "running")
      stopCompacting(live)
    if (change.error) endRetries(live, "gave-up", [change.error])
    else if (change.status !== undefined && change.status !== "running") endRetries(live, undefined)
    const next: Partial<LiveSessionState> = { ...change }
    // SAFETY: `next` is a copy of a Partial<LiveSessionState>, so its own keys are LiveSessionState's.
    for (const key of Object.keys(next) as (keyof LiveSessionState)[])
      if (next[key] !== live.state[key] && isDeepStrictEqual(next[key], live.state[key]))
        delete next[key]
    live.state = { ...live.state, ...next }
    live.emit({ type: "live-session", session: live.state })
  }
  const timing = new WeakMap<Live, Map<string, { at: number; ended: boolean }>>()
  const leaving = (live: Live, update: LiveUpdate): LiveUpdate => {
    if (update.kind !== "tool" && update.kind !== "tool-update") return stamped(update)
    let calls = timing.get(live)
    if (!calls) timing.set(live, (calls = new Map()))
    return stamped(timed(calls, update))
  }
  const emitUpdate = (live: Live, update: LiveUpdate): void => {
    if (answers(update)) endRetries(live, "recovered")
    if (update.kind === "tool") retainUndeclaredTools(live.state.harness, [update])
    observeCalls(live, [update])
    live.emit({ type: "live-update", id: live.state.id, update: leaving(live, update) })
  }
  const emitUpdates = (live: Live, updates: LiveUpdate[]): void => {
    if (updates.length === 0) return
    if (updates.some(answers)) endRetries(live, "recovered")
    retainUndeclaredTools(live.state.harness, updates)
    observeCalls(live, updates)
    live.emit({ type: "live-updates", id: live.state.id, updates: updates.map((update) => leaving(live, update)) })
  }
  /** The version the launch's handshake reported, and the stream line being decoded: where an unknown record was seen. */
  const seen = (live: Live): UnknownSeen => {
    const runtime = live.state.executionContext?.runtime
    const frame = frameOf()
    return { ...runtime?.kind === "reported" && { version: runtime.version }, ...frame && { frame } }
  }
  const unhandledEvent = (live: Live, kind: string): void => {
    retainUnknown(live.state.harness, kind, "unknown", undefined, 1, seen(live))
  }

  return {
    sessions,

    state(id: string): LiveSessionState | null {
      return sessions.get(id)?.state ?? null
    },

    patch,
    emitUpdate,
    emitUpdates,

    emitAgent(live: Live, agent: NativeAgentObservation): void {
      live.emit({ type: "live-agent", id: live.state.id, agent })
    },

    activity,
    compacted,
    event,
    observe(
      live: Live,
      kind: string,
      notices: readonly NativeNotice[] | undefined,
      source?: string
    ): void {
      if (!notices) return unhandledEvent(live, kind)
      for (const item of decodedNotices(notices, source)) {
        if (item.kind === "activity") activity(live, item.activity)
        else if (item.kind === "compacted")
          compacted(live, item.compaction, item.source)
        else if (item.kind === "marker") event(live, item.marker, item.source)
        else if (item.kind === "rewound") live.emit({ type: "live-rewound", id: live.state.id, run: item.run })
        else if (item.kind === "goal") live.emit({ type: "live-goal", id: live.state.id, goal: item.goal })
      }
    },
    unhandled: unhandledEvent,
    unknown(
      live: Live,
      kind: string,
      reason: UnknownReason,
      raw: JsonValue
    ): void {
      retainUnknown(live.state.harness, kind, reason, raw, 1, seen(live))
    },
    sink(live, handlers) {
      return {
        updates: (updates) =>
          updates.length === 1
            ? emitUpdate(live, updates[0]!)
            : emitUpdates(live, updates),
        patch: (change) => patch(live, change),
        activity: (observation) => activity(live, observation),
        marker: (marker, source) => event(live, marker, source),
        compacted: (compaction, source, completes) => compacted(live, compaction, source, completes),
        usage: (windows) => handlers.usage?.(windows),
        rewound: (run) => live.emit({ type: "live-rewound", id: live.state.id, run }),
        goal: (goal) => live.emit({ type: "live-goal", id: live.state.id, goal }),
        unknown: (kind, reason, raw) =>
          retainUnknown(live.state.harness, kind, reason, raw, 1, seen(live)),
        effect: (effect) => handlers.effect(effect),
      }
    },

    /**
     * Put a request to the desk and wait for its answer. The pending entry
     * is removed when the answer arrives; `release` answers whatever is
     * left when the session stops.
     */
    ask(
      live: PermittingLive,
      request: LivePermissionRequest
    ): Promise<LivePermissionResponse> {
      if (live.pendingPermissions.has(request.id))
        throw new Error("Repeated pending permission request")
      const observationId = randomUUID()
      return new Promise((resolve) => {
        live.pendingPermissions.set(request.id, (response, ended) => {
          live.pendingPermissions.delete(request.id)
          if (ended)
            live.emit({
              type: "live-permission-ended",
              id: live.state.id,
              requestId: request.id,
              observationId,
              source: ended,
            })
          resolve(response)
        })
        live.emit({
          type: "live-permission",
          request: { ...request, observationId },
        })
      })
    },

    respondPermission(
      id: string,
      requestId: string,
      response: LivePermissionResponse
    ): ApprovalSubmission {
      const respond = sessions.get(id)?.pendingPermissions?.get(requestId)
      if (!respond)
        return {
          kind: "not-submitted",
          pending: false,
          reason: "request-ended",
        }
      respond(response)
      return { kind: "submitted", source: "callback" }
    },

    /** Every request a stopping session leaves behind gets no choice. */
    release(live: PermittingLive): void {
      for (const resolve of live.pendingPermissions.values())
        resolve({ kind: "choice", optionId: null }, "connection-close")
      live.pendingPermissions.clear()
    },
  }
}
