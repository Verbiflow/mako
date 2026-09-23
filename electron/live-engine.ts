import { randomUUID } from "node:crypto"
import type { ApprovalSubmission, ApprovalEndSource } from "./contracts/approval-response.js"
import type {
  LiveDriverEvent,
  LivePermissionRequest,
  LivePermissionResponse,
  LiveSessionState,
  LiveUpdate,
  NativeAgentObservation,
} from "./shared.js"

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
export function createLiveEngine<Live extends EngineLive>(): LiveEngineApi<Live> {
  const sessions = new Map<string, Live>()

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
