import type { HostJobs } from "../base/host-jobs.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { errorMessage, type FailureBoundary } from "../base/error-message.js"
import { z } from "zod"
import type { Json } from "@mako/protocol"
import { ACCESS_TIER_NAMES } from "../contracts/access.js"
import {
  FIN_WORD,
  ORCHESTRATION_VERSION,
  placeDevice,
  type AgentRefused,
  type AgentsCancelInput,
  type AgentsCancelled,
  type AgentsCapabilities,
  type AgentsNoticed,
  type AgentsNoticeInput,
  type AgentsPlaced,
  type AgentsPlaceInput,
  type ApexCaller,
  type PlaceTarget,
  type Report,
  type ThreadParent,
} from "../contracts/agents.js"
import type { AgentsAnswerInput, AgentsListInput, AgentsMoveInput, AgentsReadInput, AgentsSendInput, AgentsStopInput } from "../contracts/agent-tools.js"
import { OwnerUnavailableError, RuntimeDisconnectedError } from "../contracts/host-connection.js"

/** A device of the person's account, as a place is resolved among them. */
export interface PlaceDevice {
  id: string
  name: string
  platform?: string
}

/**
 * How this host reaches the person's other places (`AgentsDeps.away`): the account's devices and one host call to a
 * place's host, through the gateway as this device. A host without it (signed out, or a build with no cloud) starts
 * Fins here only.
 */
export interface PlaceLink {
  /** This device in its account; undefined while it isn't signed in. */
  self(): Promise<string | undefined>
  /** The account's devices. */
  devices(): Promise<readonly PlaceDevice[]>
  /**
   * One host call answered by a place's host, its value decoded: a device's runtime (`d-<device>`), or a cloud
   * Thread's machine. Throws as a gateway call does: `OwnerUnavailableError` at once for a device that isn't connected.
   */
  call(target: PlaceTarget, channel: string, args: readonly Json[]): Promise<Json | undefined>
}

/** What an Apex asks of a Fin it placed, each the input of the operation it names (`AgentPlaces.ask`). */
export type PlacedAsk = AgentsListInput | AgentsReadInput | AgentsSendInput | AgentsAnswerInput | AgentsStopInput | AgentsMoveInput

/** How a place stood when it was last asked (`mako:agents-capabilities`), kept so admission reads its room without a call. */
interface Room {
  capabilities: AgentsCapabilities
  at: number
}

/** A refusal for a call to another place; `lost` when the call left and no answer came, so what it did there isn't known. */
export type AwayRefused = AgentRefused & { lost?: true }

/** A place a start named, resolved: this device, another one, or why it can't be one. */
export type ResolvedPlace = { kind: "here" } | { kind: "away"; target: PlaceTarget; where: string } | AgentRefused

const CapabilitiesSchema = z.object({
  orchestration: z.object({ version: z.number() }),
  slots: z.object({ used: z.number(), of: z.number() }),
  harnesses: z.array(z.string()),
})
const RefusedSchema = z.object({ refused: z.string(), why: z.string() })
const PlacedAnswerSchema = z.object({
  child: z.string().uuid(),
  name: z.string().min(1),
  session: z.string().optional(),
  conversation: z.string().optional(),
  harness: z.string(),
  access: z.enum(ACCESS_TIER_NAMES),
  state: z.enum(["queued", "starting", "working", "idle", "blocked", "ended"]),
  runsOn: z.string().optional(),
  note: z.string().optional(),
  deduped: z.literal(true).optional(),
}).loose()
const CancelledSchema = z.object({ cancelled: z.literal(true), fin: PlacedAnswerSchema.optional() })
const NoticedSchema = z.union([z.object({ heard: z.literal(true), deduped: z.literal(true).optional() }), RefusedSchema])

/** What an old host answers a call it doesn't have (`fromHostOperation`). */
const NO_SUCH_CALL = "This host has no such call"

/** A notice not taken is sent again after this long, doubling to `OUTBOX_RETRY_MAX_MS`. */
export const OUTBOX_RETRY_MS = 5_000
export const OUTBOX_RETRY_MAX_MS = 5 * 60_000
/** How often the outbox looks at what's due, only while something waits. */
export const OUTBOX_EVERY_MS = 5_000
export const OUTBOX_JOB = "send Fins' notices to their Apexes' devices"

/** A notice waiting in a Fin's device's outbox: its edge, its report, and what the Apex's device is sent. */
export interface OutboxNotice {
  edge: ThreadParent
  report: Report
}

export interface AgentPlacesDeps {
  link: PlaceLink
  jobs: HostJobs
  /** The notices no Apex's device has taken yet, oldest first, each on an edge whose Apex is on another device. */
  waiting(): OutboxNotice[]
  /** The Apex's device took it, or will never take it (a stale owner's): it leaves the outbox. */
  taken(report: Report, at: number): void
  /** How a Fin here stands as a notice of `report` is sent (`AgentsNoticeInput.standing`). */
  standing(edge: ThreadParent, report: Report): NonNullable<AgentsNoticeInput["standing"]>
  now?(): number
}

/**
 * Fins on the person's other places (`place: device:<name>`), as far as the wire goes. For an Apex here: a place's
 * name resolved among the account's devices, what that place offers (`mako:agents-capabilities`), the start itself
 * (`mako:agents-place`) and the Apex's operations on a Fin it placed, each one host call on the place's runtime as an
 * `ApexCaller`. For a Fin here whose Apex is elsewhere: its notices, each sent to the Apex's device
 * (`mako:agents-notice`) until that device takes it. The outbox is the store's undelivered reports, so nothing is
 * kept here but when each device is next tried.
 */
export class AgentPlaces {
  private readonly deps: AgentPlacesDeps
  private readonly rooms = new Map<string, Room>()
  /** By Apex device: when its notices are next tried, and how long the wait after that is. */
  private readonly retries = new Map<string, { at: number; waitMs: number }>()
  private readonly flushing = new Map<string, Promise<void>>()
  private readonly again = new Set<string>()
  private readonly demand
  private readonly stopJob: () => void
  private stopped = false

  constructor(deps: AgentPlacesDeps) {
    this.deps = deps
    this.demand = deps.jobs.demand("notices for Apexes on other devices")
    this.stopJob = deps.jobs.every(OUTBOX_JOB, OUTBOX_EVERY_MS, () => this.due(), { needs: [this.demand] })
  }

  dispose(): void {
    this.stopped = true
    this.stopJob()
  }

  /** This device in its account. */
  self(): Promise<string | undefined> {
    return this.deps.link.self().catch(() => undefined)
  }

  // ── An Apex here ──

  /**
   * The place a start named, among the account's devices: a name is taken whatever its case, and must name one device.
   * This device's own name is `here`.
   */
  async resolve(place: string): Promise<ResolvedPlace> {
    const name = placeDevice(place)
    if (name === undefined) return { refused: "place-unavailable", why: `${place} isn't a place this build starts a ${FIN_WORD} in yet: here or device:<name>.` }
    let devices: readonly PlaceDevice[]
    let self: string | undefined
    try {
      ;[devices, self] = await Promise.all([this.deps.link.devices(), this.deps.link.self()])
    } catch (error) {
      return { refused: "place-unavailable", why: `The account's devices couldn't be read (${errorMessage({ error })}), so ${name} can't be found. Leave place out to start it here.` }
    }
    if (!self) return { refused: "place-unavailable", why: `This device isn't signed in to Mako, so it can't reach ${name}. Leave place out to start it here.` }
    const wanted = name.trim().toLowerCase()
    const found = devices.filter((device) => device.name.trim().toLowerCase() === wanted)
    const others = devices.filter((device) => device.id !== self).map((device) => device.name)
    if (!found.length)
      return { refused: "place-unavailable", why: `No device of this account is named ${name}. ${others.length ? `Its other devices: ${others.join(", ")}.` : "It has no other device: add one with mako-host join."}` }
    if (found.length > 1)
      return { refused: "place-unavailable", why: `${found.length} devices of this account are named ${name} (${found.map((device) => `${device.name}${device.platform ? `, ${device.platform}` : ""}`).join("; ")}), so the place is ambiguous. Rename one in Settings › Devices, then name it.` }
    const device = found[0]!
    if (device.id === self) return { kind: "here" }
    return { kind: "away", target: { kind: "device", device: device.id, name: device.name }, where: `device:${device.name}` }
  }

  /**
   * What a place offers now, asked of it: refused, with why, when it isn't connected, when its Mako is older than
   * placement, or when it speaks a version this build doesn't.
   */
  async capabilities(target: PlaceTarget, where: string): Promise<AgentsCapabilities | AgentRefused> {
    const name = placeName(target)
    let answer: unknown
    try {
      answer = await this.deps.link.call(target, "mako:agents-capabilities", [])
    } catch (error) {
      return awayRefusal({ error }, name, "start")
    }
    const parsed = CapabilitiesSchema.safeParse(answer)
    if (!parsed.success) return { refused: "unsupported", why: `${name} answered something this Mako can't read as a place for ${FIN_WORD}s. Update Mako on both.` }
    if (parsed.data.orchestration.version !== ORCHESTRATION_VERSION)
      return { refused: "unsupported", why: `${name} speaks version ${parsed.data.orchestration.version} of placing ${FIN_WORD}s and this device version ${ORCHESTRATION_VERSION}. Update Mako on ${parsed.data.orchestration.version < ORCHESTRATION_VERSION ? name : "this device"}.` }
    this.rooms.set(where, { capabilities: parsed.data, at: this.now() })
    return parsed.data
  }

  /** A place's room as it last said it; undefined before it was asked. */
  room(where: string): AgentsCapabilities | undefined {
    return this.rooms.get(where)?.capabilities
  }

  /** A Fin was placed in `where`: it has one place less until it's asked again. */
  took(where: string): void {
    const room = this.rooms.get(where)
    if (room) this.rooms.set(where, { ...room, capabilities: { ...room.capabilities, slots: { ...room.capabilities.slots, used: Math.min(room.capabilities.slots.of, room.capabilities.slots.used + 1) } } })
  }

  /** `where` refused a start as full: it has no place until it's asked again. */
  filled(where: string): void {
    const room = this.rooms.get(where)
    if (room) this.rooms.set(where, { ...room, capabilities: { ...room.capabilities, slots: { ...room.capabilities.slots, used: room.capabilities.slots.of } } })
  }

  /** A place stopped answering: nothing is known of its room until it's asked again. */
  forget(where: string): void {
    this.rooms.delete(where)
  }

  /**
   * The start itself, settled by its op on the place's host: a repeat answers the same Fin. `lost` when the call
   * left and no answer came, so whether the Fin started there isn't known: only the same op, asked again, says.
   */
  async place(target: PlaceTarget, input: AgentsPlaceInput): Promise<AgentsPlaced | AgentRefused | { lost: string }> {
    const name = placeName(target)
    let answer: unknown
    try {
      answer = await this.deps.link.call(target, "mako:agents-place", [wire(input)])
    } catch (error) {
      if (error instanceof RuntimeDisconnectedError && error.unconfirmed) return { lost: errorMessage({ error }) }
      return awayRefusal({ error }, name, "start")
    }
    const refused = RefusedSchema.safeParse(answer)
    if (refused.success) return asRefused(refused.data)
    const placed = PlacedAnswerSchema.safeParse(answer)
    if (!placed.success) return { refused: "unavailable", why: `${name} answered the start with something this Mako can't read: ${z.prettifyError(placed.error)}` }
    // SAFETY: PlacedAnswerSchema holds every field of AgentsPlaced to its type; `state` is one of ChildState's kinds.
    return placed.data as AgentsPlaced
  }

  /**
   * One of an Apex's operations on a Fin it placed (`mako:agents-<verb>`), answered by the Fin's device as it answers
   * its own Apexes, with this Apex as the caller. A refusal comes back as one; a place that can't be reached is one too.
   */
  async ask<Answer extends object>(target: PlaceTarget, channel: string, caller: ApexCaller, input: PlacedAsk, what: string): Promise<Answer | AwayRefused> {
    try {
      const answer = await this.deps.link.call(target, channel, [wire(caller), wire(input)])
      const refused = RefusedSchema.safeParse(answer)
      if (refused.success) return asRefused(refused.data)
      // SAFETY: the place's host answers each `mako:agents-<verb>` with that verb's result, as it does on its own socket.
      return answer as Answer
    } catch (error) {
      return awayRefusal({ error }, placeName(target), what)
    }
  }

  /**
   * A stop of a placed start whose outcome isn't known (`mako:agents-cancel`), settled by the start's op on the
   * place's host. Any refusal leaves the stop where it was kept, to be sent again.
   */
  async cancel(target: PlaceTarget, input: AgentsCancelInput): Promise<AgentsCancelled> {
    const name = placeName(target)
    try {
      const answer = await this.deps.link.call(target, "mako:agents-cancel", [wire(input)])
      const refused = RefusedSchema.safeParse(answer)
      if (refused.success) return asRefused(refused.data)
      const cancelled = CancelledSchema.safeParse(answer)
      if (!cancelled.success) return { refused: "unavailable", why: `${name} answered the stop with something this Mako can't read: ${z.prettifyError(cancelled.error)}` }
      // SAFETY: PlacedAnswerSchema holds every field of AgentsPlaced to its type; `state` is one of ChildState's kinds.
      return { cancelled: true, ...(cancelled.data.fin && { fin: cancelled.data.fin as AgentsPlaced }) }
    } catch (error) {
      return awayRefusal({ error }, name, "be stopped")
    }
  }

  // ── A Fin here, its Apex elsewhere ──

  /** A notice waits for `device`: sent now, unless that device is being waited out. */
  queued(device: string): void {
    this.demand.set(true)
    const retry = this.retries.get(device)
    if (retry && retry.at > this.now()) return
    void this.flush(device)
  }

  /** `device` was heard from (it called for its Fins here), so it's back: what waits for it goes now. */
  heard(device: string): void {
    if (!this.retries.delete(device) && !this.deps.waiting().some(({ edge }) => edge.remote?.device === device)) return
    void this.flush(device)
  }

  /**
   * A Fin here stands otherwise than its last notice said, with nothing new to report: its last report again, with
   * how it stands now. Sent once and not kept: its Apex's device asks how its Fins stand when it's back and before
   * it admits a start, so one this misses is still counted.
   */
  restate(notice: OutboxNotice): void {
    const device = notice.edge.remote?.device
    if (!device || this.stopped) return
    const input = this.noticeOf(notice)
    this.deps.link.call({ kind: "device", device, name: device }, "mako:agents-notice", [wire(input)]).then(
      () => hostLog("agents", "standing sent", { notice: input.id, device, working: input.standing?.working ?? false }),
      (error: Error) => hostLog("agents", "standing not sent", { notice: input.id, device, why: errorMessage({ error }) }),
    )
  }

  private noticeOf({ edge, report }: OutboxNotice): AgentsNoticeInput {
    return { id: `notice:${edge.child}:${report.id}`, op: edge.op, parent: { thread: edge.parent, session: edge.parentSession }, child: edge.child, report, standing: this.deps.standing(edge, report) }
  }

  /** How many notices wait for an Apex's device to take them, for Diagnostics. */
  pending(): number {
    return this.deps.waiting().length
  }

  /** What the last host left unsent, and whatever is due: tried now. */
  resume(): void {
    const devices = new Set(this.deps.waiting().flatMap(({ edge }) => edge.remote?.device ?? []))
    this.demand.set(devices.size > 0)
    for (const device of devices) void this.flush(device)
  }

  private due(): void {
    const waiting = this.deps.waiting()
    const devices = new Set(waiting.flatMap(({ edge }) => edge.remote?.device ?? []))
    this.demand.set(devices.size > 0)
    const now = this.now()
    for (const device of devices) if ((this.retries.get(device)?.at ?? 0) <= now) void this.flush(device)
  }

  /** Sends `device` its notices in order, one flush at a time: the first not taken ends it, and is tried again later. */
  private flush(device: string): Promise<void> {
    const running = this.flushing.get(device)
    if (running) {
      this.again.add(device)
      return running
    }
    const run = this.send(device).finally(() => {
      this.flushing.delete(device)
      if (this.again.delete(device) && !this.stopped && !this.retries.has(device)) void this.flush(device)
    })
    this.flushing.set(device, run)
    return run
  }

  private async send(device: string): Promise<void> {
    for (const { edge, report } of this.deps.waiting()) {
      if (this.stopped) return
      if (edge.remote?.device !== device) continue
      const input = this.noticeOf({ edge, report })
      const id = input.id
      const began = this.now()
      let answer: AgentsNoticed
      try {
        const parsed = NoticedSchema.safeParse(await this.deps.link.call({ kind: "device", device, name: device }, "mako:agents-notice", [wire(input)]))
        answer = !parsed.success ? { refused: "unavailable", why: "Its device answered something this Mako can't read." } : "refused" in parsed.data ? asRefused(parsed.data) : parsed.data
      } catch (error) {
        return this.wait(device, id, error instanceof OwnerUnavailableError && !error.unconfirmed ? "its device isn't connected" : errorMessage({ error }))
      }
      if ("refused" in answer && answer.refused !== "stale-owner") return this.wait(device, id, `${answer.refused}: ${answer.why}`)
      this.deps.taken(report, this.now())
      this.retries.delete(device)
      hostLog("agents", "notice sent", { notice: id, device, ms: this.now() - began, ...("refused" in answer ? { refused: answer.refused } : answer.deduped && { deduped: true }) })
    }
    if (!this.deps.waiting().length) this.demand.set(false)
  }

  /** Not taken: it stays in the outbox, and its device is tried again later, each wait twice the last. */
  private wait(device: string, notice: string, why: string): void {
    const waitMs = Math.min(OUTBOX_RETRY_MAX_MS, (this.retries.get(device)?.waitMs ?? OUTBOX_RETRY_MS / 2) * 2)
    this.retries.set(device, { at: this.now() + waitMs, waitMs })
    this.demand.set(true)
    hostLog("agents", "notice waits", { notice, device, why, againInMs: waitMs })
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}

/** A place as its refusals name it. */
export function placeName(target: PlaceTarget): string {
  return target.kind === "device" ? target.name : "The cloud"
}

/** A refusal another host gave, as this one's: a reason this build doesn't know is `unavailable`, in its words. */
function asRefused(refused: z.infer<typeof RefusedSchema>): AgentRefused {
  // SAFETY: the reasons are this contract's own; one a newer host added is read as `unavailable` by whoever branches on it.
  return { refused: refused.refused as AgentRefused["refused"], why: refused.why }
}

/** A call's argument as it crosses: what JSON carries of it, an absent member left out. */
function wire(value: ApexCaller | PlacedAsk | AgentsPlaceInput | AgentsNoticeInput | AgentsCancelInput): Json {
  return z.json().parse(JSON.parse(JSON.stringify(value)))
}

/** Why a call to a place didn't answer, as a refusal: it isn't connected, its Mako is too old, or the call was lost. */
export function awayRefusal({ error }: FailureBoundary, name: string, what: string): AwayRefused {
  if (error instanceof OwnerUnavailableError && !error.unconfirmed)
    return { refused: "place-unavailable", why: `${name} isn't online: its Mako isn't connected to the account now, so nothing can ${what} there. Try again once it's back, or leave place out to work here.` }
  if (error instanceof RuntimeDisconnectedError)
    return error.unconfirmed
      ? { refused: "unavailable", why: `${name} didn't answer, so whether it took this isn't known. Ask again with the same clientKey: it answers what it did, and does nothing twice.`, lost: true }
      : { refused: "unavailable", why: `This device couldn't reach ${name} through the account now: ${error.message}` }
  const message = errorMessage({ error })
  if (message.startsWith(NO_SUCH_CALL))
    return { refused: "unsupported", why: `${name} runs a Mako from before ${FIN_WORD}s could be placed on another device. Update Mako there, then ask again.` }
  hostWarn("agents", "a call to another place failed", { place: name, what, error: message })
  return { refused: "unavailable", why: `${name} couldn't ${what} it: ${message}` }
}
