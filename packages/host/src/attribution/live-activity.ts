import { isAbsolute, resolve } from "node:path"
import type { ActivityMark, AttributionTracker, ReportedEffect } from "@mako/protocol"
import type { LiveUpdate } from "@mako/sessions/live-content"
import type { ToolEffect } from "@mako/sessions/tool-effects"
import { liveEffectsStatus } from "@mako/sessions/tool-effect-reading"
import { identifyTool } from "@mako/sessions/tool-identity"
import { activeWork } from "../contracts/background-work.js"
import { requestsAfter, type LiveBatch, type LiveRequest } from "../contracts/live-conversations.js"
import type { NativeAgent } from "../contracts/native-agents.js"
import { readOnlyCall } from "./read-only.js"

/*
 * The live conversations, read as activity: a turn runs while its session
 * is `running`; a tool call runs from its first update until its status says
 * it finished; its reported effects come on its tool updates. Read from the
 * batches the host already sends every window, so attribution adds no hook
 * to any harness's driver.
 *
 * A turn's id is the request it answers (`LiveRequest.id`): the request
 * dispatching when it starts, the one id checkpoints, rewind and Changes
 * use too, the same after a reopen or a restart. A turn the harness runs on
 * its own (a background agent's report) answers no request, and is named
 * for when it started. The harness's own run id rides along as metadata,
 * held for one turn only, so a turn that starts before the harness names
 * its run never takes the last one's.
 */

export interface LiveActivityDeps {
  tracker: Pick<AttributionTracker, "activity" | "reported">
  /** The Thread a conversation belongs to, and its Session there. */
  placement(conversationId: string): Placement | undefined
  /** What the host knows of a conversation already, for one first heard mid-way: its folder, harness and native record. */
  session(conversationId: string): { cwd?: string; harness?: string; record?: string } | undefined
  /** The checkout a folder is in, once it's tracked; undefined while that's being found. */
  checkout(cwd: string): string | undefined
  /** A turn started in `cwd`: make sure its checkout is tracked. */
  working(cwd: string): void
  now(): number
}

interface Call {
  started: number
  ended: boolean
  harness: string
  name?: string
  title?: string
  acpKind?: string
  input?: string
  /** The start of the output, which says whether the harness refused the call. */
  output: string
  status: string
  effects?: readonly ToolEffect[]
}

interface Conversation {
  status?: string
  harness?: string
  cwd?: string
  /** The harness's id for the run in progress, as reported this turn. */
  runId?: string
  /** The request being answered, while one dispatches. */
  dispatching?: string
  requests?: readonly LiveRequest[]
  /** The harness's own record of the session. */
  record?: string
  turn?: string
  calls: Map<string, Call>
  /** Work the session runs on its own (subagents, commands left running, monitors), by its native id. */
  work: Map<string, { started: number; named: string[] }>
}

interface Placement {
  thread: string
  session: string
}

/** The fields every mark of a conversation shares. */
interface MarkFields extends Placement {
  turn?: string
  run?: string
  cwd?: string
  checkout?: string
}

/** What a call names, for its marks. */
interface Naming {
  label: string
  named: string[]
  readOnly?: true
}

/** Output kept per call to read a refusal from. */
const OUTPUT_HEAD = 512
/** A word in a command line that reads as a path. */
const PATH_WORD = /(?:^|\s)((?:\/|\.{1,2}\/|~\/)[^\s'"`;|&<>()]+)/g

export class LiveActivity {
  private readonly deps: LiveActivityDeps
  private readonly conversations = new Map<string, Conversation>()

  constructor(deps: LiveActivityDeps) {
    this.deps = deps
  }

  observe(batch: LiveBatch): void {
    let conversation = this.conversations.get(batch.id)
    if (!conversation) {
      const known = this.deps.session(batch.id)
      conversation = { calls: new Map(), work: new Map(), cwd: known?.cwd, harness: known?.harness, record: known?.record }
      this.conversations.set(batch.id, conversation)
    }
    const session = batch.session ?? batch.sessionChanges
    if (session?.harness) conversation.harness = session.harness
    if (session?.cwd) conversation.cwd = session.cwd
    // A run id only as the harness reports it changing, or as the request records it: a session sent whole still carries the last turn's.
    if (batch.sessionChanges?.nativeRunId) conversation.runId = batch.sessionChanges.nativeRunId
    if (batch.threadPath) conversation.record = batch.threadPath
    const requests = requestsAfter(conversation.requests, batch)
    if (requests) {
      conversation.requests = requests
      const dispatching = requests.filter((request) => request.status === "dispatching").at(-1)
      conversation.dispatching = dispatching?.id
      if (dispatching?.nativeRun && dispatching.id === conversation.turn) conversation.runId = dispatching.nativeRun.runId
    }
    const status = session?.status
    // The next request went out while the session still showed the last turn running: that turn is over.
    if (conversation.turn && conversation.dispatching && conversation.turn !== conversation.dispatching && (status ?? conversation.status) === "running" && requests)
      this.turnEnded(batch.id, conversation)
    if (status === "running" && !conversation.turn) this.turnStarted(batch.id, conversation)
    for (const update of batch.updates) this.update(batch.id, conversation, update)
    if (batch.nativeAgents !== undefined || status === "closed") this.work(batch.id, conversation, status === "closed" ? [] : activeWork(batch.nativeAgents))
    if (status !== undefined && status !== "running" && conversation.turn) this.turnEnded(batch.id, conversation)
    if (status === "closed") this.conversations.delete(batch.id)
    conversation.status = status ?? conversation.status
  }

  /** What every mark of this conversation carries: whose it is, and where it ran. */
  private about(conversation: Conversation, placed: Placement): MarkFields {
    const cwd = conversation.cwd
    const fields: MarkFields = { thread: placed.thread, session: placed.session, turn: conversation.turn, cwd, checkout: cwd ? this.deps.checkout(cwd) : undefined }
    if (conversation.runId) fields.run = conversation.runId
    return fields
  }

  private turnStarted(id: string, conversation: Conversation): void {
    const placed = this.deps.placement(id)
    conversation.turn = conversation.dispatching ?? `own-${this.deps.now()}`
    const request = conversation.requests?.find((item) => item.id === conversation.turn)
    if (request?.nativeRun) conversation.runId = request.nativeRun.runId
    if (conversation.cwd) this.deps.working(conversation.cwd)
    if (!placed) return
    this.deps.tracker.activity({ ...this.about(conversation, placed), kind: "turn", id: conversation.turn, edge: "start", at: this.deps.now(), record: conversation.record })
  }

  private turnEnded(id: string, conversation: Conversation): void {
    const placed = this.deps.placement(id)
    for (const [callId, call] of conversation.calls) if (!call.ended) this.callEnded(id, conversation, callId, call)
    conversation.calls.clear()
    const turn = conversation.turn!
    if (placed) this.deps.tracker.activity({ ...this.about(conversation, placed), kind: "turn", id: turn, edge: "end", at: this.deps.now(), record: conversation.record })
    conversation.turn = undefined
    conversation.runId = undefined
  }

  /** Background work starts when the roster first names it active, and ends when it no longer does. */
  private work(id: string, conversation: Conversation, active: readonly Pick<NativeAgent, "nativeId" | "title" | "detail" | "work">[]): void {
    const placed = this.deps.placement(id)
    const now = this.deps.now()
    const live = new Set(active.map((agent) => agent.nativeId))
    for (const agent of active) {
      if (conversation.work.has(agent.nativeId)) continue
      const named = this.paths(conversation, agent.detail ?? "")
      conversation.work.set(agent.nativeId, { started: now, named })
      if (!placed) continue
      const mark: ActivityMark = { ...this.about(conversation, placed), kind: "background", id: agent.nativeId, edge: "start", at: now, label: agent.title.slice(0, 200), named, record: conversation.record }
      // An agent or workflow works toward an end; a command, monitor or task runs on its own as long as it's left.
      if (agent.work === "command" || agent.work === "monitor" || agent.work === "task") mark.standing = true
      this.deps.tracker.activity(mark)
    }
    for (const [workId, work] of conversation.work) {
      if (live.has(workId)) continue
      conversation.work.delete(workId)
      if (placed) this.deps.tracker.activity({ ...this.about(conversation, placed), kind: "background", id: workId, edge: "end", at: Math.max(now, work.started), record: conversation.record })
    }
  }

  /** Words of a command line that read as paths, resolved against the session's folder. */
  private paths(conversation: Conversation, command: string): string[] {
    const named = new Set<string>()
    for (const match of command.slice(0, 16_000).matchAll(PATH_WORD)) {
      const word = match[1]!
      if (word.startsWith("~/")) continue
      const path = isAbsolute(word) ? word : conversation.cwd ? resolve(conversation.cwd, word) : undefined
      if (path) named.add(path)
    }
    return [...named].slice(0, 256)
  }

  private update(id: string, conversation: Conversation, update: LiveUpdate): void {
    if (update.kind !== "tool" && update.kind !== "tool-update") return
    let call = conversation.calls.get(update.id)
    const fresh = !call
    if (!call) {
      if (update.kind === "tool-update") return
      if (!conversation.turn) this.turnStarted(id, conversation)
      call = { started: this.deps.now(), ended: false, harness: conversation.harness ?? "", output: "", status: update.status }
      conversation.calls.set(update.id, call)
    }
    if (update.kind === "tool") {
      call.name = update.name
      call.title = update.title
      call.acpKind = update.toolKind
      if (update.input !== undefined) call.input = update.input
    } else if (update.input !== undefined) call.input = update.input
    else if (update.inputAppend) call.input = `${call.input ?? ""}${update.inputAppend}`
    if (update.status) call.status = update.status
    if (update.output !== undefined) call.output = update.output.slice(0, OUTPUT_HEAD)
    else if (update.kind === "tool-update" && update.outputAppend && call.output.length < OUTPUT_HEAD) call.output = `${call.output}${update.outputAppend}`.slice(0, OUTPUT_HEAD)
    if (update.effects) call.effects = update.effects
    const placed = this.deps.placement(id)
    if (fresh && placed) this.deps.tracker.activity({ ...this.about(conversation, placed), ...this.named(conversation, call), kind: "call", id: update.id, edge: "start", at: call.started })
    const status = liveEffectsStatus(call.harness, { status: call.status, output: call.output })
    if (status !== "running") this.callEnded(id, conversation, update.id, call)
    else if (update.effects && placed) this.report(conversation, update.id, call, placed, "running")
  }

  private callEnded(id: string, conversation: Conversation, callId: string, call: Call): void {
    if (call.ended) return
    call.ended = true
    const placed = this.deps.placement(id)
    if (!placed) return
    const at = this.deps.now()
    this.deps.tracker.activity({ ...this.about(conversation, placed), ...this.named(conversation, call), kind: "call", id: callId, edge: "end", at })
    this.report(conversation, callId, call, placed, liveEffectsStatus(call.harness, { status: call.status, output: call.output }), at)
  }

  private report(conversation: Conversation, callId: string, call: Call, placed: Placement, status: "completed" | "failed" | "refused" | "running", endedAt?: number): void {
    if (!call.effects?.length) return
    const about = this.about(conversation, placed)
    this.deps.tracker.reported({
      thread: about.thread,
      session: about.session,
      turn: about.turn,
      checkout: about.checkout,
      call: callId,
      startedAt: call.started,
      endedAt,
      status,
      effects: call.effects.map(reportedEffect),
    })
  }

  /** The paths a call names: its target, and words of its command line that read as paths. */
  private named(conversation: Conversation, call: Call): Naming {
    const identity = identifyTool({ harness: call.harness, name: call.name, title: call.title, acpKind: call.acpKind, input: call.input })
    const cwd = conversation.cwd
    const named = new Set<string>()
    if (identity.path) {
      const path = isAbsolute(identity.path) ? identity.path : cwd ? resolve(cwd, identity.path) : undefined
      if (path) named.add(path)
    }
    if (identity.command) for (const path of this.paths(conversation, identity.command)) named.add(path)
    const naming: Naming = { label: identity.label.slice(0, 200), named: [...named].slice(0, 256) }
    if (readOnlyCall(identity.kind, identity.command)) naming.readOnly = true
    return naming
  }
}

/** A harness's effect in the open contract's words. */
export function reportedEffect(effect: ToolEffect): ReportedEffect {
  switch (effect.kind) {
    case "create":
      return { kind: "create", path: effect.path, content: effect.content, seen: effect.seen }
    case "write":
      return { kind: "write", path: effect.path, content: effect.content }
    case "modify":
      return { kind: "modify", path: effect.path, patch: effect.patch, edits: effect.edits?.map((edit) => ({ old: edit.old, new: edit.new, all: edit.all })), seen: effect.seen }
    case "delete":
      return { kind: "delete", path: effect.path, seen: effect.seen }
    case "read":
      return { kind: "read", path: effect.path }
    case "rename":
      return { kind: "rename", from: effect.from, to: effect.to }
    case "command":
      return { kind: "command", command: effect.command, cwd: effect.cwd, exitCode: effect.exitCode, named: effect.named, background: effect.background }
  }
}
