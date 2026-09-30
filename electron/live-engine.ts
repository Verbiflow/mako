import { randomUUID } from "node:crypto"
import type { ApprovalSubmission, ApprovalEndSource } from "./contracts/approval-response.js"
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
import { compactionEvent, type Compaction, type TranscriptEvent } from "@mako/sessions/events"
import { hostLog } from "./host-log.js"

/** What a live engine's per-session record must carry to share the runtime. */
export interface EngineLive {
  state: LiveSessionState
  emit(event: LiveDriverEvent): void
  /** Present when the engine answers requests through a pending map. */
  pendingPermissions?: Map<string, (response: LivePermissionResponse, ended?: ApprovalEndSource) => void>
}

/** Sessions whose permission requests resolve through a pending map. */
export interface PermittingLive extends EngineLive {
  pendingPermissions: Map<string, (response: LivePermissionResponse, ended?: ApprovalEndSource) => void>
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
  /** The provider compacted the conversation: the transcript marks it and compacting ends. */
  compacted(live: Live, compaction?: Compaction): void
  /** A marker in the transcript: a provider notice, warning or failure. */
  event(live: Live, event: TranscriptEvent): void
  /**
   * Apply what a harness decoder made of one native event; `undefined`
   * means the decoder does not know it, and `kind` is logged as unhandled.
   */
  observe(live: Live, kind: string, notices: readonly NativeNotice[] | undefined): void
  /**
   * A native event this engine does not translate. Logged once per harness
   * and kind for the host's life, so a new provider event is on record
   * without a line per occurrence.
   */
  unhandled(live: Live, kind: string): void
  /**
   * Put a request to the desk and wait for its answer. The pending entry
   * is removed when the answer arrives; `release` answers whatever is
   * left when the session stops.
   */
  ask(live: PermittingLive, request: LivePermissionRequest): Promise<LivePermissionResponse>
  respondPermission(id: string, requestId: string, response: LivePermissionResponse): ApprovalSubmission
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
const unhandled = new Set<string>()

export function createLiveEngine<Live extends EngineLive>(): LiveEngineApi<Live> {
  const sessions = new Map<string, Live>()
  const activity = (live: Live, observation: NativeActivityObservation | null): void =>
    live.emit({ type: "live-activity", id: live.state.id, activity: observation })
  const event = (live: Live, marker: TranscriptEvent): void =>
    live.emit({ type: "live-update", id: live.state.id, update: { kind: "event", ...marker } })
  const compacted = (live: Live, compaction?: Compaction): void => {
    event(live, compactionEvent(compaction))
    activity(live, null)
  }
  const unhandledEvent = (live: Live, kind: string): void => {
    const key = `${live.state.harness}\0${kind}`
    if (unhandled.has(key)) return
    unhandled.add(key)
    hostLog("live", "native event not handled", { harness: live.state.harness, kind })
  }

  return {
    sessions,

    state(id: string): LiveSessionState | null {
      return sessions.get(id)?.state ?? null
    },

    /** Patch the session's state and report the new whole. */
    patch(live: Live, patch: Partial<LiveSessionState>): void {
      live.state = { ...live.state, ...patch }
      live.emit({ type: "live-session", session: live.state })
    },

    emitUpdate(live: Live, update: LiveUpdate): void {
      live.emit({ type: "live-update", id: live.state.id, update })
    },

    emitUpdates(live: Live, updates: LiveUpdate[]): void {
      if (updates.length === 0) return
      live.emit({ type: "live-updates", id: live.state.id, updates })
    },

    emitAgent(live: Live, agent: NativeAgentObservation): void {
      live.emit({ type: "live-agent", id: live.state.id, agent })
    },

    activity,
    compacted,
    event,
    observe(live: Live, kind: string, notices: readonly NativeNotice[] | undefined): void {
      if (!notices) return unhandledEvent(live, kind)
      for (const notice of notices) {
        if (notice.kind === "activity") activity(live, notice.activity)
        else if (notice.kind === "compacted") compacted(live, notice.compaction)
        else event(live, notice.event)
      }
    },
    unhandled: unhandledEvent,

    /**
     * Put a request to the desk and wait for its answer. The pending entry
     * is removed when the answer arrives; `release` answers whatever is
     * left when the session stops.
     */
    ask(live: PermittingLive, request: LivePermissionRequest): Promise<LivePermissionResponse> {
      if (live.pendingPermissions.has(request.id)) throw new Error("Repeated pending permission request")
      const observationId = randomUUID()
      return new Promise((resolve) => {
        live.pendingPermissions.set(request.id, (response, ended) => {
          live.pendingPermissions.delete(request.id)
          if (ended) live.emit({ type: "live-permission-ended", id: live.state.id, requestId: request.id, observationId, source: ended })
          resolve(response)
        })
        live.emit({ type: "live-permission", request: { ...request, observationId } })
      })
    },

    respondPermission(
      id: string,
      requestId: string,
      response: LivePermissionResponse
    ): ApprovalSubmission {
      const respond = sessions.get(id)?.pendingPermissions?.get(requestId)
      if (!respond) return { kind: "not-submitted", pending: false, reason: "request-ended" }
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
