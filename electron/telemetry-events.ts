import type { LiveRequest, LiveSnapshot } from "./contracts/live-conversations.js"
import type { LiveSessionState } from "./contracts/providers-acp.js"
import type { HarnessUpdates } from "./contracts/harness-updates.js"
import type { DiagnosticEvents, ProductEvents, TelemetryTokens, TurnTuning } from "./contracts/telemetry.js"
import type { CrashReport } from "./crash.js"
import type { UnknownKind } from "./native-unknown.js"

/**
 * Mako's own state as telemetry events: code identifiers, counts and
 * durations picked out field by field, so nothing a person wrote can ride
 * along. A value that doesn't look like an identifier is left out, not
 * truncated.
 */
const IDENT = /^[A-Za-z0-9][\w.:-]*$/
const HARNESS = /^[a-z][a-z0-9-]{0,23}$/
const MODEL = /^[\w.:/@+[\]-]+$/
const TERMINAL: ReadonlySet<LiveRequest["status"]> = new Set(["completed", "failed", "uncertain", "interrupted"])
const ACCESS = new Set(["plan", "chat", "ask", "edits", "auto", "full", "deny"])

type Ended = ProductEvents["turn.completed"]["status"]
const ended = (status: LiveRequest["status"]): status is Ended => TERMINAL.has(status)

function ident(value: string | null | undefined, max: number): string | undefined {
  return value && value.length <= max && IDENT.test(value) ? value : undefined
}

export function harnessId(value: string): string | undefined {
  return HARNESS.test(value) ? value : undefined
}

/** The harness, model, reasoning effort and mode a request runs with. */
export function tuningOf(session: LiveSessionState, request?: LiveRequest): TurnTuning | undefined {
  const harness = harnessId(session.harness)
  if (!harness) return undefined
  const settings = { ...session.settings, ...request?.tuning, options: { ...session.settings?.options, ...request?.tuning?.options } }
  const model = settings.model && settings.model.length <= 100 && MODEL.test(settings.model) ? settings.model : undefined
  const reasoning = session.configOptions.find((option) => option.role === "reasoning")
  const chosen = reasoning && (settings.options[reasoning.id] ?? (reasoning.kind === "select" ? reasoning.current : undefined))
  const effort = chosen === true || chosen === false ? undefined : ident(chosen, 24)
  const mode = ident(session.currentMode, 48)
  const access = session.modes.find((candidate) => candidate.id === session.currentMode)?.access
  return {
    harness,
    ...(model && { model }),
    ...(effort && { effort }),
    ...(mode && { mode }),
    ...(access && ACCESS.has(access) && { access }),
  }
}

export interface TurnChanges {
  started: LiveRequest[]
  settled: LiveRequest[]
}

/**
 * The requests whose turn began, and those that ended, between two committed
 * snapshots. A commit keeps every request it didn't change as the same
 * object, so only the changed ones are looked up.
 */
export function turnChanges(previous: Pick<LiveSnapshot, "requests">, next: Pick<LiveSnapshot, "requests">): TurnChanges {
  const before = previous.requests
  const started: LiveRequest[] = []
  const settled: LiveRequest[] = []
  for (const [index, request] of next.requests.entries()) {
    if (before[index] === request) continue
    const was = (before[index]?.id === request.id ? before[index] : before.find((candidate) => candidate.id === request.id))?.status
    if (was === request.status) continue
    if (request.status === "dispatching") started.push(request)
    else if (ended(request.status) && (was === undefined || !ended(was))) settled.push(request)
  }
  return { started, settled }
}

export function turnStarted(session: LiveSessionState, request: LiveRequest): ProductEvents["turn.started"] | undefined {
  const tuning = tuningOf(session, request)
  if (!tuning) return undefined
  return {
    ...tuning,
    attachments: Math.min(request.attachments.length, 1_000),
    ...(request.actor && { actor: request.actor.kind }),
    continuation: Boolean(request.continues),
  }
}

export function turnCompleted(
  snapshot: Pick<LiveSnapshot, "session" | "nativeAgents">,
  request: LiveRequest,
  durationMs: number | undefined
): ProductEvents["turn.completed"] | undefined {
  const tuning = tuningOf(snapshot.session, request)
  const status = request.status
  if (!tuning || !ended(status)) return undefined
  const spend = request.spend
  const tokens = spend?.tokens && tokensOf(spend.tokens)
  const cost = spend?.cost
  const failure = ident(request.failure, 40)
  const interruption = ident(request.interruption?.reason, 40)
  return {
    ...tuning,
    status,
    ...(failure && { failure }),
    ...(interruption && { interruption }),
    ...(durationMs !== undefined && durationMs >= 0 && { durationMs: Math.min(Math.round(durationMs), 7 * 86_400_000) }),
    ...(tokens && { tokens }),
    ...(cost !== undefined && Number.isFinite(cost) && cost >= 0 && { costUsd: Math.min(cost, 10_000) }),
    usage: tokens || cost !== undefined ? (spend?.unrecorded ? "partial" : "complete") : "none",
    subagents: Math.min(snapshot.nativeAgents?.agents.filter((agent) => agent.requestId === request.id).length ?? 0, 10_000),
  }
}

function tokensOf(tokens: TelemetryTokens): TelemetryTokens | undefined {
  const count = (value: number) => Math.min(Math.max(0, Math.round(value)), 1e12)
  const counted = { input: count(tokens.input), cacheRead: count(tokens.cacheRead), cacheWrite: count(tokens.cacheWrite), output: count(tokens.output) }
  if (![tokens.input, tokens.cacheRead, tokens.cacheWrite, tokens.output].every(Number.isFinite)) return undefined
  return tokens.reasoning !== undefined && Number.isFinite(tokens.reasoning) ? { ...counted, reasoning: count(tokens.reasoning) } : counted
}

/** Each available harness with the version installed, as the runtime readings have it. */
export function harnessInventory(available: readonly string[], runtimes: HarnessUpdates): ProductEvents["app.heartbeat"]["harnesses"] {
  const inventory: ProductEvents["app.heartbeat"]["harnesses"] = []
  for (const id of available) {
    const harness = harnessId(id)
    if (!harness) continue
    const reading = Object.entries(runtimes).find(([key, info]) => (info.provider ?? key) === id && info.primary !== false && info.installed)?.[1]
    const version = reading?.installed?.match(/\d+(?:\.\d+)+[\w.+-]*/)?.[0]
    inventory.push(version && version.length <= 40 ? { harness, version } : { harness })
    if (inventory.length >= 24) break
  }
  return inventory
}

/** A crash report as an error report: the words and frames, scrubbed by `Telemetry.report`, and the trail's notes without their times. */
export function errorReported(crash: CrashReport): DiagnosticEvents["error.reported"] {
  const name = ident(crash.stack?.match(/^([A-Z]\w*(?:Error|Exception)\b)/)?.[1], 80)
  return {
    kind: ident(crash.kind, 40) ?? "unknown",
    ...(name && { name }),
    message: crash.message.slice(0, 500),
    ...(crash.stack && { stack: crash.stack.slice(0, 4_000) }),
    ...(crash.breadcrumbs.length && { breadcrumbs: crash.breadcrumbs.slice(-20).map((note) => note.replace(/^\S+\s/, "").slice(0, 120)) }),
  }
}

/**
 * How many more of each native record kind no decoder understood since the
 * last report. An MCP tool's name says which servers someone runs, so it is
 * reported only as an MCP tool.
 */
export function unknownSince(kinds: readonly UnknownKind[], reported: Map<string, number>): Array<DiagnosticEvents["native.unknown"]> {
  const events: Array<DiagnosticEvents["native.unknown"]> = []
  for (const entry of kinds) {
    const harness = harnessId(entry.harness)
    const kind = /^tool .*(?:mcp|__)/i.test(entry.kind) ? "tool <mcp>" : entry.kind
    if (!harness || kind.length > 120 || !/^[\w .:/@<>-]+$/.test(kind)) continue
    const key = `${harness}\0${entry.kind}\0${entry.reason}`
    const count = entry.count - (reported.get(key) ?? 0)
    reported.set(key, entry.count)
    if (count > 0) events.push({ harness, kind, reason: entry.reason, count })
  }
  return events
}
