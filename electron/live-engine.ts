import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type {
  ApprovalSubmission,
  ApprovalEndSource,
} from "./contracts/approval-response.js"
import type {
  LiveDriverEvent,
  LivePermissionRequest,
  LivePermissionResponse,
  LiveSessionState,
  LiveUpdate,
  NativeActivityObservation,
  NativeAgentObservation,
  NativeNotice,
} from "./shared.js"
import {
  compactionEvent,
  type Compaction,
  type TranscriptEvent,
} from "@mako/sessions/events"
import type { JsonValue } from "./codex-app-json.js"
import {
  decodedNotices,
  type DecodedSink,
} from "./contracts/native-decoding.js"
import { retainUndeclaredTools, retainUnknown, type UnknownReason } from "./native-unknown.js"

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
  compacted(live: Live, compaction?: Compaction, id?: string): void
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
      usage?(windows: import("./account-types.js").UsageWindow[]): void
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

/** When the provider last said it was compacting, and when it stopped saying so. */
interface Compacting {
  since: number
  until?: number
}

export function createLiveEngine<
  Live extends EngineLive,
>(): LiveEngineApi<Live> {
  const sessions = new Map<string, Live>()
  const compacting = new WeakMap<Live, Compacting>()
  /** Compacting stops when the provider reports something else, or its turn ends; a retry is part of it. */
  const stopCompacting = (live: Live): void => {
    const held = compacting.get(live)
    if (held && held.until === undefined) held.until = Date.now()
  }
  const activity = (
    live: Live,
    observation: NativeActivityObservation | null
  ): void => {
    const held = compacting.get(live)
    if (observation?.kind === "compacting") {
      if (!held || held.until !== undefined)
        compacting.set(live, { since: Date.now() })
    } else if (observation?.kind !== "retrying") stopCompacting(live)
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
    const update: LiveUpdate = id
      ? {
          kind: "event",
          ...marker,
          id,
          source: marker.source ?? { harness: live.state.harness, record: id },
        }
      : { kind: "event", ...marker }
    live.emit({ type: "live-update", id: live.state.id, update })
  }
  const compacted = (
    live: Live,
    compaction?: Compaction,
    id?: string
  ): void => {
    const held = compacting.get(live)
    compacting.delete(live)
    const until = held?.until ?? Date.now()
    const measured =
      held &&
      compaction?.durationMs === undefined &&
      Date.now() - until < COMPACTION_LINGER_MS
        ? { ...compaction, durationMs: until - held.since }
        : compaction
    event(live, compactionEvent(measured), id)
    activity(live, null)
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
    const next: Partial<LiveSessionState> = { ...change }
    // SAFETY: `next` is a copy of a Partial<LiveSessionState>, so its own keys are LiveSessionState's.
    for (const key of Object.keys(next) as (keyof LiveSessionState)[])
      if (next[key] !== live.state[key] && isDeepStrictEqual(next[key], live.state[key]))
        delete next[key]
    live.state = { ...live.state, ...next }
    live.emit({ type: "live-session", session: live.state })
  }
  const emitUpdate = (live: Live, update: LiveUpdate): void => {
    if (update.kind === "tool") retainUndeclaredTools(live.state.harness, [update])
    live.emit({ type: "live-update", id: live.state.id, update })
  }
  const emitUpdates = (live: Live, updates: LiveUpdate[]): void => {
    if (updates.length === 0) return
    retainUndeclaredTools(live.state.harness, updates)
    live.emit({ type: "live-updates", id: live.state.id, updates })
  }
  const unhandledEvent = (live: Live, kind: string): void => {
    retainUnknown(live.state.harness, kind, "unknown")
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
      }
    },
    unhandled: unhandledEvent,
    unknown(
      live: Live,
      kind: string,
      reason: UnknownReason,
      raw: JsonValue
    ): void {
      retainUnknown(live.state.harness, kind, reason, raw)
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
        compacted: (compaction, source) => compacted(live, compaction, source),
        usage: (windows) => handlers.usage?.(windows),
        rewound: (run) => live.emit({ type: "live-rewound", id: live.state.id, run }),
        unknown: (kind, reason, raw) =>
          retainUnknown(live.state.harness, kind, reason, raw),
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
