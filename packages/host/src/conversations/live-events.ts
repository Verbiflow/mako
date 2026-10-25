import { carriedUsage } from "../harnesses/index.js"
import type { LiveBatch, LiveDriverEvent, LiveRequest } from "../contracts/live-conversations.js"
import { GoalObservationSchema } from "../contracts/live-goals.js"
import type { NativeActivity, NativeActivityObservation } from "../contracts/native-activity.js"
import { disconnectNativeAgents, NativeAgentObservationSchema, observeNativeAgent } from "../contracts/native-agents.js"
import type { LiveSessionState } from "../contracts/providers-acp.js"
import { holdForSignIn } from "../contracts/sign-in-hold.js"
import { hostWarn } from "../base/host-log.js"
import { drawnWhileOpening, queueLiveUpdate } from "@mako/sessions/live-content"
import type { LiveActions } from "./live-actions.js"
import type { LiveApprovals } from "./live-approvals.js"
import type { LiveAssets } from "./live-assets.js"
import { recordCutOff } from "./live-auto-continue.js"
import type { LiveCheckpoints } from "./live-checkpoints.js"
import { releaseExited } from "./live-launches.js"
import type { LiveQuestions } from "./live-questions.js"
import { revokeTools, type LiveAccess, type Resident } from "./live-runtime.js"
import { settleRequest } from "./live-settlement.js"
import { updateBinding } from "./live-sources.js"

type EventsAccess = Pick<LiveAccess,
  "dependencies" | "bindingOwners" | "resident" | "control" | "flush" | "schedule" | "drain" | "storageFailed" | "signInHold" |
  "scheduleAutoContinue" | "goalSettled" | "goalObserved" | "goalSpent" | "nativeRewound" | "scheduleHibernation" | "clearHibernationTimer">

/** The parts a driver's events land in. */
export interface EventParts {
  actions: LiveActions
  approvals: LiveApprovals
  questions: LiveQuestions
  checkpoints: LiveCheckpoints
  assets: LiveAssets
}

/** What drivers report, taken into the conversation each binding belongs to. */
export class LiveEvents {
  private readonly access: EventsAccess
  private readonly parts: EventParts

  constructor(access: EventsAccess, parts: EventParts) {
    this.access = access
    this.parts = parts
  }

  observe(event: LiveDriverEvent): void {
    try {
      this.accept(event)
    } catch (error) {
      const id =
        event.type === "live-session"
          ? event.session.id
          : event.type === "live-permission"
            ? event.request.sessionId
            : event.id
      const resident = this.access.resident(this.access.bindingOwners.get(id) ?? id)
      if (resident) this.access.storageFailed(resident, { error })
    }
  }

  private accept(raw: LiveDriverEvent): void {
    const { dependencies } = this.access
    const { actions, approvals, questions, checkpoints } = this.parts
    const bindingId =
      raw.type === "live-session"
        ? raw.session.id
        : raw.type === "live-permission"
          ? raw.request.sessionId
          : raw.id
    const owner = this.access.bindingOwners.get(bindingId) ?? bindingId
    const bound = this.access.resident(owner)
    if (!bound) return
    // Everything else it says opening is the history it replays, which the conversation already shows.
    const opening = bound.transferOpening
    if (opening?.bindingId === bindingId && (raw.type === "live-update" || raw.type === "live-updates")) {
      opening.said.push(...(raw.type === "live-update" ? [raw.update] : raw.updates).filter(drawnWhileOpening))
      return
    }
    if (this.access.control(bound).activeBindingId !== bindingId) {
      const connection = bound.connections.get(bindingId)
      if (connection && raw.type === "live-session") {
        connection.session = raw.session
        if (raw.session.connection === "disconnected") {
          bound.connections.delete(bindingId)
          void revokeTools(dependencies, bindingId, owner)
          if (!bound.closing && !bound.hibernating) releaseExited(bound, connection.driver, owner, bindingId)
        }
      }
      return
    }
    const event: LiveDriverEvent =
      raw.type === "live-session"
        ? { ...raw, session: { ...raw.session, id: owner } }
        : raw.type === "live-permission"
          ? { ...raw, request: { ...raw.request, sessionId: owner } }
          : { ...raw, id: owner }
    const id =
      event.type === "live-session"
        ? event.session.id
        : event.type === "live-permission"
          ? event.request.sessionId
          : event.id
    const resident = this.access.resident(id)
    // A reconnect may recover retained evidence before the new driver is ready.
    // Its generation-fenced callback and exact saved native occurrence own admission.
    if (!resident || (!resident.driver && event.type !== "live-approval-decision" && event.type !== "live-question" && event.type !== "live-question-answered")) return
    // Opening streams the provider's saved history back; it is not new work.
    const replaying = resident.opening && Boolean(resident.snapshot.base || resident.snapshot.baseSource || resident.snapshot.blocks.length)
    let progressOnly = false
    if (showsActivity(event, resident.snapshot.session.status, replaying))
      resident.activityAt = Date.now()
    if (event.type === "live-session") {
      const previousStatus = resident.snapshot.session.status
      const finishedRequest = resident.snapshot.requests.find(
        (request) => request.status === "dispatching"
      )
      resident.snapshot = {
        ...resident.snapshot,
        session: {
          ...event.session,
          title: event.session.title ?? resident.snapshot.session.title,
          usage: carriedUsage(resident.snapshot.session, event.session),
          configOptions: carriedOptions(resident.snapshot.session, event.session),
        },
        nativeActivity: event.session.status === "running" ? resident.snapshot.nativeActivity : undefined,
      }
      if (event.session.nativeRunId && event.session.status === "running") {
        const runId = event.session.nativeRunId
        resident.snapshot = {
          ...resident.snapshot,
          requests: resident.snapshot.requests.map((request) =>
            request.status === "dispatching" && !request.nativeRun
              ? { ...request, nativeRun: { bindingId, runId } }
              : request
          ),
        }
      }
      // Startup reports are observations, not permission to replace an admitted
      // source. Wake validates the returned session before committing its binding.
      if (!resident.opening) updateBinding(dependencies, resident, event.session)
      const connection = resident.connections.get(bindingId)
      if (connection) connection.session = { ...event.session, id: bindingId }
      if (event.session.connection === "disconnected") {
        const exited = connection?.driver ?? resident.driver
        resident.snapshot = {
          ...resident.snapshot,
          nativeAgents: disconnectNativeAgents(
            resident.snapshot.nativeAgents,
            bindingId
          ),
        }
        resident.driver = null
        resident.connections.delete(bindingId)
        void revokeTools(dependencies, bindingId, id)
        if (exited && !resident.closing && !resident.hibernating) releaseExited(resident, exited, id, bindingId)
      }
      if (event.session.status === "running") this.access.goalSpent(resident)
      const gone = event.session.connection === "disconnected" || event.session.status === "closed"
      // The request this turn's end settles: only one the harness was given (`handedOver`), unless its process went.
      const settling = finishedRequest && (gone || handedOver(finishedRequest)) ? finishedRequest : undefined
      if ((previousStatus === "running" && event.session.status !== "running") || gone) {
        actions.settle(resident, bindingId)
        approvals.settle(resident, bindingId)
      }
      // Once the process is gone nothing reports a request it was handed, so
      // it settles here even if its turn never showed as running.
      if ((previousStatus === "running" && event.session.status !== "running") || (gone && settling)) {
        const outcome = previousStatus === "running" || event.session.status !== "ready"
          ? event.session
          : { ...event.session, status: "failed" as const, error: event.session.error ?? "The provider stopped before the turn started" }
        if (previousStatus !== "running" && settling)
          hostWarn("live", "a request's provider went away before its turn ran", {
            conversation: resident.snapshot.session.id, request: settling.id,
            delivery: settling.nativeDelivery?.evidence.kind ?? "none", status: event.session.status,
          })
        resident.snapshot = {
          ...resident.snapshot,
          permissions: [],
          requests: resident.snapshot.requests.map((request) =>
            request.status === "dispatching" && (gone || handedOver(request))
              ? settleRequest(
                  request,
                  outcome,
                  resident.closing || resident.stopping === request.id,
                  resident.stopping === request.id ? resident.stoppingFor : undefined,
                  resident.stopping === request.id ? resident.stoppingWork : undefined
                )
              : request
          ),
        }
        resident.stopping = undefined
        resident.stoppingFor = undefined
        resident.stoppingWork = undefined
        if (settling) {
          if (resident.snapshot.requests.find((request) => request.id === settling.id)?.failure === "auth")
            resident.snapshot = {
              ...resident.snapshot,
              requests: holdForSignIn(resident.snapshot.requests, this.access.signInHold(resident), settling.id),
            }
          recordCutOff(resident, settling.id, dependencies.root)
          if (resident.snapshot.requests.find((request) => request.id === settling.id)?.status === "held")
            dependencies.workspaceSnapshots?.abandonRun(settling.id)
          else checkpoints.settle(resident, settling.id)
          this.access.scheduleAutoContinue(resident, settling.id)
          this.access.goalSettled(resident, settling.id)
        }
      }
    } else if (event.type === "live-rewound") {
      this.access.nativeRewound(resident, event.run)
    } else if (event.type === "live-goal") {
      this.access.goalObserved(resident, event.goal === null ? null : GoalObservationSchema.parse(event.goal))
    } else if (event.type === "live-action-result") {
      actions.result(resident, bindingId, event.actionId, event.result)
    } else if (event.type === "live-agent") {
      const agent = NativeAgentObservationSchema.parse(event.agent)
      const before = resident.snapshot.nativeAgents?.agents.find((current) => current.bindingId === bindingId && current.nativeId === agent.nativeId)
      progressOnly = before?.state.kind === "working" && agent.state.kind === "working" && before.nativeRunId === agent.nativeRunId
      resident.snapshot = {
        ...resident.snapshot,
        nativeAgents: observeNativeAgent(resident.snapshot.nativeAgents, {
          ...agent,
          bindingId,
          provider: resident.snapshot.session.harness,
          requestId: resident.snapshot.requests.find(
            (request) => request.status === "dispatching"
          )?.id,
          observedAt: Date.now(),
        }),
      }
    } else if (event.type === "live-activity") {
      const nativeActivity = observeNativeActivity(
        resident.snapshot.nativeActivity,
        resident.snapshot.session.status === "running" && !replaying ? event.activity : null
      )
      if (nativeActivity !== resident.snapshot.nativeActivity)
        resident.snapshot = { ...resident.snapshot, nativeActivity }
    } else if (event.type === "live-question-answered") {
      questions.observeAnswer(resident, bindingId, event.answer)
    } else if (event.type === "live-question") {
      questions.observe(resident, bindingId, event.question)
    } else if (event.type === "live-approval-decision") {
      approvals.decision(resident, bindingId, event.decision)
    } else if (event.type === "live-permission-ended") {
      approvals.end(resident, bindingId, event)
    } else if (event.type === "live-permission") {
      approvals.observe(resident, event.request)
    } else {
      this.take(resident, (event.type === "live-update" ? [event.update] : event.updates)
        .filter((update) => !replaying || drawnWhileOpening(update)))
    }
    // Control and terminal changes flush ahead of the next turn. Text bursts share one frame.
    // A roster entry's progress (a tool count, a status line) shares the frame too; its start and end flush.
    if (event.type === "live-session" || event.type === "live-question-answered" || event.type === "live-question" || event.type === "live-permission" || event.type === "live-permission-ended" || event.type === "live-approval-decision" || (event.type === "live-agent" && !progressOnly) || event.type === "live-activity" || event.type === "live-goal")
      this.access.flush(resident)
    else this.access.schedule(resident)
    if (event.type === "live-session" || event.type === "live-agent") {
      if (
        resident.snapshot.session.status === "ready" &&
        resident.snapshot.session.connection === "connected"
      )
        this.access.scheduleHibernation(resident)
      else this.access.clearHibernationTimer(resident)
    }
    if (!resident.opening && resident.snapshot.session.status === "ready")
      this.access.drain(resident)
  }

  /** The conversation's updates, queued for its next flush. */
  take(resident: Resident, updates: LiveBatch["updates"]): void {
    const dispatching = resident.snapshot.requests.some(
      (request) => request.status === "dispatching"
    )
    const prepared = updates.flatMap((item) => {
      try {
        return this.parts.assets.prepare(item)
      } catch (error) {
        resident.updates.push(item)
        this.access.storageFailed(resident, { error })
        return []
      }
    })
    // The model answering again is the end of a retry's wait.
    if (resident.snapshot.nativeActivity?.kind === "retrying" && prepared.some((update) => update.kind !== "user"))
      resident.snapshot = { ...resident.snapshot, nativeActivity: undefined }
    for (const update of prepared) {
      if (dispatching && update.kind === "user") continue
      resident.steps?.observe(update)
      if (queueLiveUpdate(resident, update) === "full") {
        this.access.flush(resident)
        queueLiveUpdate(resident, update)
      }
    }
  }
}

/** A binding's events, while it is still the one its conversation listens to; a later start of either fences them off. */
export function driverEvents(
  resident: Resident,
  bindingId: string,
  observe: (event: LiveDriverEvent) => void
): (event: LiveDriverEvent) => void {
  const bindingGeneration =
    (resident.bindingGenerations.get(bindingId) ?? 0) + 1
  const residentGeneration = resident.generation
  resident.bindingGenerations.set(bindingId, bindingGeneration)
  return (event) => {
    if (
      resident.generation === residentGeneration &&
      resident.bindingGenerations.get(bindingId) === bindingGeneration
    )
      observe(event)
  }
}

/**
 * A process still starting has reported no options; the list the last one
 * reported stands until it does, so the composer keeps its choices and an
 * unchanged list is not sent to the window again.
 */
function carriedOptions(previous: LiveSessionState, next: LiveSessionState): LiveSessionState["configOptions"] {
  return next.connection === "starting" && !next.configOptions.length && next.harness === previous.harness
    ? previous.configOptions
    : next.configOptions
}

/** Whether the event shows the provider working, for `LiveSnapshot.activityAt`. */
function showsActivity(event: LiveDriverEvent, status: LiveSessionState["status"], replaying: boolean): boolean {
  switch (event.type) {
    case "live-session":
      return event.session.status === "running" && status !== "running"
    case "live-update":
      return !replaying
    case "live-updates":
      return event.updates.length > 0 && !replaying
    case "live-permission":
    case "live-question":
    case "live-agent":
      return true
    case "live-activity":
      return event.activity !== null && !replaying
    default:
      return false
  }
}

/**
 * The running turn's activity after `observation`: the same object when
 * nothing changed, so a repeated report publishes nothing, and the first
 * `since` while the provider keeps doing the same kind of thing.
 */
function observeNativeActivity(
  current: NativeActivity | undefined,
  observation: NativeActivityObservation | null
): NativeActivity | undefined {
  if (!observation) return undefined
  const next = { ...observation, since: current?.kind === observation.kind ? current.since : Date.now() }
  return current && JSON.stringify(current) === JSON.stringify(next) ? current : next
}

/**
 * Whether the harness was given a request, so a turn that ends is its turn: not one still being prepared, nor one
 * it refused before taking it. A turn the harness started itself (Claude Code's notice of background work it found
 * stopped, as a handed-off session reopens) can begin and end while a message is prepared; that message's own send
 * or refusal settles it, never the end of a turn it wasn't in. A process that's gone settles everything regardless.
 */
function handedOver(request: LiveRequest): boolean {
  const evidence = request.nativeDelivery?.evidence.kind
  return evidence !== "prepared" && evidence !== "not-accepted"
}
