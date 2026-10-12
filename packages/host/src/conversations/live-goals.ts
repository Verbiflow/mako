import { hostLog, hostWarn } from "../base/host-log.js"
import type { LiveRequest, LiveSnapshot } from "../contracts/live-conversations.js"
import {
  GOAL_CONTINUE_DELAY_MS,
  GOAL_QUIET_LIMIT,
  goalContinuePrompt,
  goalStartPrompt,
  observeGoal,
  readGoalReport,
  GoalCommandSchema,
  type ConversationGoal,
  type GoalCommand,
  type GoalObservation,
} from "../contracts/live-goals.js"
import type { Actor } from "../contracts/thread-identity.js"
import type { DriverGoalCommand, GoalsCapability } from "../harnesses/index.js"
import { isTurnStart, reduceLiveUpdates } from "@mako/sessions/live-content"
import { activeBinding, conversationControl, type LiveAccess, type Resident } from "./live-runtime.js"

type GoalsAccess = Pick<LiveAccess, "dependencies" | "admission" | "resident" | "load" | "flush" | "pending" | "reopens" | "wake" | "snapshot">

/** A message the goal sends, admitted the way the user's own messages are. */
export interface GoalMessage {
  text: string
  displayText?: string
  goal: NonNullable<LiveRequest["goal"]>
  actor?: Actor
  tuning?: LiveRequest["tuning"]
}

export interface GoalSender {
  actor?: Actor
  tuning?: LiveRequest["tuning"]
}

const GOAL_ACTOR: Actor = { kind: "service", name: "goal" }

/**
 * The goal a conversation works toward. A harness with its own goal keeps it:
 * Mako sends each command the way the harness's own client does and shows
 * what the harness reports. A harness without one gets Mako's loop: the
 * objective goes as a message, and after each turn that ends with the goal
 * still active, Mako continues it until the agent reports it complete or
 * blocked, the user stops it, or turns keep ending with nothing done.
 */
export class LiveGoals {
  private readonly access: GoalsAccess
  private readonly submit: (id: string, message: GoalMessage) => LiveRequest

  constructor(access: GoalsAccess, submit: (id: string, message: GoalMessage) => LiveRequest) {
    this.access = access
    this.submit = submit
  }

  /** `sender`: who gave the command, and the composer's settings for the message it sends. */
  async command(id: string, command: GoalCommand, sender: GoalSender = {}): Promise<LiveSnapshot> {
    this.access.admission.assert()
    const resident = this.access.load(id)
    if (!resident) throw new Error("This conversation is no longer available")
    const goals = this.capability(resident)
    const goal = resident.snapshot.goal
    refuseCommand(command, goal)
    if (goals.kind === "mako") this.makosCommand(resident, command, sender)
    else await this.nativeCommand(resident, goals, command, sender)
    this.access.flush(resident)
    return this.access.snapshot(id) ?? resident.snapshot
  }

  /** A conversation that starts with a goal: set once it exists, and shown blocked with the reason if it can't be. */
  begin(id: string, objective: string, sender: GoalSender): void {
    const command = GoalCommandSchema.options[0].parse({ kind: "set", objective })
    void this.command(id, command, sender).catch((error) => {
      const resident = this.access.resident(id)
      if (!resident) return
      const now = this.now()
      const by = this.capability(resident).kind === "native" ? "harness" : "mako"
      this.setGoal(resident, { objective: command.objective, status: "blocked", by, setAt: now, updatedAt: now, note: `Mako couldn't set the goal: ${error instanceof Error ? error.message : String(error)}` })
      this.access.flush(resident)
    })
  }

  /** What the harness reports about its own goal. */
  observe(resident: Resident, observation: GoalObservation | null): void {
    const next = observeGoal(resident.snapshot.goal, observation, this.now())
    if (next !== resident.snapshot.goal) this.setGoal(resident, next)
  }

  /** A turn ended. Mako's loop continues an active goal; a harness's goal message it never confirmed is said so. */
  settled(resident: Resident, settled: string): void {
    const goal = resident.snapshot.goal
    const request = resident.snapshot.requests.find((candidate) => candidate.id === settled)
    if (!goal || !request) return
    if (goal.by === "harness") {
      if (goal.pending && request.goal?.step === goal.pending) this.setGoal(resident, unconfirmed(goal, this.now()))
      return
    }
    if (goal.status !== "active") return
    switch (request.status) {
      case "held":
        return
      case "interrupted":
        // A dropped connection is auto-continue's; the goal goes on after that turn.
        if (request.interruption?.reason === "stopped") this.update(resident, { status: "paused" })
        return
      case "uncertain":
        this.update(resident, { status: "paused", note: "Mako couldn't tell whether the last turn ran." })
        return
      case "failed":
        this.update(resident, { status: "blocked", note: request.error ? `The turn failed: ${request.error}` : "The turn failed." })
        return
      case "completed":
        break
      default:
        return
    }
    const reply = turnReply(resident, settled)
    const turns = (goal.turns ?? 0) + 1
    const report = readGoalReport(reply.text)
    if (report.kind !== "working") {
      this.update(resident, { status: report.kind, turns, note: report.note, quiet: undefined })
      hostLog("live", "goal reported", { conversation: resident.snapshot.session.id, status: report.kind, turns })
      return
    }
    const quiet = reply.worked ? 0 : (goal.quiet ?? 0) + 1
    if (quiet >= GOAL_QUIET_LIMIT) {
      this.update(resident, { status: "blocked", turns, quiet: undefined, note: `The agent ended ${quiet} turns in a row without replying or doing anything.` })
      return
    }
    this.update(resident, { turns, quiet: quiet || undefined, note: undefined })
    this.schedule(resident)
  }

  /**
   * The user pressed Stop: the goal pauses, as Codex's own client pauses it,
   * so nothing starts the next turn. A call pauses it before the turn is
   * interrupted, since the harness continues an idle goal itself; a message
   * can only go once the stopped turn has ended, so it is returned for then.
   */
  async stopping(resident: Resident): Promise<(() => Promise<void>) | undefined> {
    if (resident.snapshot.goal?.status !== "active") return undefined
    const goals = this.capability(resident)
    if (goals.kind === "mako") {
      this.makosCommand(resident, { kind: "pause" })
      this.access.flush(resident)
      return undefined
    }
    const pause = async () => {
      if (resident.snapshot.goal?.status !== "active") return
      await this.nativeCommand(resident, goals, { kind: "pause" }, { actor: GOAL_ACTOR }).catch((error) =>
        hostWarn("live", "the goal was not paused on Stop", { conversation: resident.snapshot.session.id, error: String(error) }))
      this.access.flush(resident)
    }
    if (goals.send({ kind: "pause" }).via === "message") return pause
    await pause()
    return undefined
  }

  /** A message from the user supersedes the continuation Mako was about to send; the loop goes on after its turn. */
  decline(resident: Resident): void {
    if (!resident.goalContinue) return
    clearTimeout(resident.goalContinue)
    resident.goalContinue = undefined
  }

  private makosCommand(resident: Resident, command: GoalCommand, { actor, tuning }: GoalSender = {}): void {
    const goal = resident.snapshot.goal
    const id = resident.snapshot.session.id
    const now = this.now()
    this.decline(resident)
    this.cancelContinuations(resident)
    switch (command.kind) {
      case "set": {
        const previous = goal
        this.setGoal(resident, { objective: command.objective, status: "active", by: "mako", setAt: now, updatedAt: now, turns: 0 })
        try {
          this.submit(id, { text: goalStartPrompt(command.objective), displayText: `/goal ${command.objective}`, goal: { step: "set" }, actor, tuning: tuning ?? lastTuning(resident) })
        } catch (error) {
          this.setGoal(resident, previous)
          throw error
        }
        return
      }
      case "pause":
        this.update(resident, { status: "paused" })
        return
      case "resume":
        this.update(resident, { status: "active", quiet: undefined, note: undefined })
        if (this.idle(resident)) this.continueGoal(resident)
        return
      case "clear":
        this.setGoal(resident, undefined)
        return
    }
  }

  private async nativeCommand(resident: Resident, goals: Extract<GoalsCapability, { kind: "native" }>, command: GoalCommand, { actor, tuning }: GoalSender): Promise<void> {
    const previous = resident.snapshot.goal
    const now = this.now()
    const delivery = goals.send(driverCommand(command, previous))
    const pending = command.kind
    this.setGoal(resident, expected(previous, command, now))
    try {
      if (delivery.via === "message") {
        const id = resident.snapshot.session.id
        const sent = tuning ?? lastTuning(resident)
        const last = delivery.texts.length - 1
        delivery.texts.forEach((text, index) =>
          this.submit(id, index === last
            ? { text, goal: { step: command.kind }, actor, tuning: sent }
            : { text, goal: { step: "clear" }, actor: GOAL_ACTOR, tuning: sent }))
        return
      }
      if (resident.opening) await resident.openingOperation?.catch(() => undefined)
      if (!resident.driver && this.access.reopens(resident)) await this.access.wake(resident)
      if (!resident.driver) throw new Error("This conversation isn't connected. Send a message to reconnect it, then try again.")
      await delivery.run(conversationControl(resident).activeBindingId)
    } catch (error) {
      if (resident.snapshot.goal?.pending === pending) this.setGoal(resident, previous)
      throw error
    }
  }

  private schedule(resident: Resident): void {
    this.decline(resident)
    const id = resident.snapshot.session.id
    const delay = this.access.dependencies.goalContinueDelayMs ?? GOAL_CONTINUE_DELAY_MS
    const timer = setTimeout(() => this.fire(id), delay)
    timer.unref?.()
    resident.goalContinue = timer
  }

  private fire(id: string): void {
    const resident = this.access.resident(id)
    if (!resident?.goalContinue) return
    resident.goalContinue = undefined
    const goal = resident.snapshot.goal
    if (goal?.by !== "mako" || goal.status !== "active" || !this.idle(resident)) return
    this.continueGoal(resident)
    this.access.flush(resident)
  }

  private continueGoal(resident: Resident): void {
    const goal = resident.snapshot.goal!
    try {
      this.access.admission.assert()
      this.submit(resident.snapshot.session.id, {
        text: goalContinuePrompt(goal.objective),
        goal: { step: "continue", turn: (goal.turns ?? 0) + 1 },
        actor: GOAL_ACTOR,
        tuning: lastTuning(resident),
      })
    } catch (error) {
      hostWarn("live", "the goal was not continued", { conversation: resident.snapshot.session.id, error: String(error) })
      this.update(resident, { status: "paused", note: `Mako couldn't continue: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  /** Nothing else is about to run: a message the user queued, an approval, a continuation of a dropped turn. */
  private idle(resident: Resident): boolean {
    const { session, requests, permissions } = resident.snapshot
    return !resident.rewinding && !resident.closing && !resident.autoContinue && !this.access.pending(resident) &&
      session.status !== "running" && session.status !== "closed" && !permissions.length &&
      !requests.some((request) => request.status === "queued" || request.status === "dispatching" || request.status === "held")
  }

  private cancelContinuations(resident: Resident): void {
    if (!resident.snapshot.requests.some(isQueuedContinuation)) return
    resident.snapshot = {
      ...resident.snapshot,
      requests: resident.snapshot.requests.map((request) => isQueuedContinuation(request) ? { ...request, status: "canceled" } : request),
    }
  }

  private update(resident: Resident, change: Partial<ConversationGoal>): void {
    const goal = resident.snapshot.goal
    if (goal) this.setGoal(resident, { ...goal, ...change, updatedAt: this.now() })
  }

  private setGoal(resident: Resident, goal: ConversationGoal | undefined): void {
    resident.snapshot = { ...resident.snapshot, goal }
  }

  private capability(resident: Resident): GoalsCapability {
    const provider = activeBinding(resident)?.provider ?? resident.snapshot.session.harness
    const goals = this.access.dependencies.driver(provider)?.goals
    if (!goals) throw new Error("This conversation's agent isn't available")
    return goals
  }

  private now(): number {
    return this.access.dependencies.now?.() ?? Date.now()
  }
}

/** Why a command can't apply to the goal as it stands, in the words the composer shows. */
function refuseCommand(command: GoalCommand, goal: ConversationGoal | undefined): void {
  if (command.kind === "pause" && goal?.status !== "active") throw new Error("There's no running goal to pause.")
  if (command.kind === "resume" && (!goal || goal.status === "active" || goal.status === "complete")) throw new Error("There's no paused goal to resume.")
  if (command.kind === "clear" && !goal) throw new Error("This conversation has no goal.")
}

function driverCommand(command: GoalCommand, goal: ConversationGoal | undefined): DriverGoalCommand {
  switch (command.kind) {
    case "set":
      return { ...command, replacing: Boolean(goal && goal.status !== "complete") }
    case "resume":
      if (!goal) throw new Error("There's no paused goal to resume.")
      return { kind: "resume", objective: goal.objective, from: goal.status }
    default:
      return command
  }
}

/** The harness's goal as it will be once it takes the command, marked pending until it says so. */
function expected(goal: ConversationGoal | undefined, command: GoalCommand, now: number): ConversationGoal {
  const pending = command.kind
  switch (command.kind) {
    case "set":
      return { objective: command.objective, status: "active", by: "harness", setAt: now, updatedAt: now, pending }
    case "pause":
      return { ...goal!, status: "paused", updatedAt: now, pending }
    case "resume":
      return { ...goal!, status: "active", note: undefined, updatedAt: now, pending }
    case "clear":
      return { ...goal!, updatedAt: now, pending }
  }
}

/** A goal message whose turn ended without the harness saying it took the command. */
function unconfirmed(goal: ConversationGoal, now: number): ConversationGoal | undefined {
  switch (goal.pending) {
    case "clear":
      return undefined
    case "pause":
      return { ...goal, pending: undefined, updatedAt: now }
    default:
      return { ...goal, pending: undefined, status: "blocked", note: "The agent didn't confirm the goal.", updatedAt: now }
  }
}

/** The settings the conversation's latest message went with, so the goal's messages keep its model. */
function lastTuning(resident: Resident): LiveRequest["tuning"] {
  const { requests } = resident.snapshot
  for (let index = requests.length - 1; index >= 0; index -= 1) if (requests[index]!.tuning) return requests[index]!.tuning
  return undefined
}

function lastIndex<T>(items: readonly T[], matches: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) if (matches(items[index]!)) return index
  return -1
}

function isQueuedContinuation(request: LiveRequest): boolean {
  return request.status === "queued" && request.goal?.step === "continue"
}

/** What the agent said at the end of the request's turn, and whether the turn did anything at all. */
interface TurnReply {
  text: string
  worked: boolean
}

function turnReply(resident: Resident, requestId: string): TurnReply {
  const blocks = reduceLiveUpdates(resident.snapshot.blocks, resident.updates)
  const start = lastIndex(blocks, (block) => block.type === "user" && block.requestId === requestId && !block.steeringFor)
  if (start < 0) return { text: "", worked: true }
  const rest = blocks.slice(start + 1)
  const next = rest.findIndex((block) => isTurnStart(block))
  const turn = next < 0 ? rest : rest.slice(0, next)
  const lastTool = lastIndex(turn, (block) => block.type === "tool")
  const text = turn.slice(lastTool + 1).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
  return { text, worked: lastTool >= 0 || text.trim().length > 0 }
}
