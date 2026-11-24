import type { HostJobs } from "../base/host-jobs.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { errorMessage, type FailureBoundary } from "../base/error-message.js"
import { z } from "zod"
import type { Json } from "@mako/protocol"
import { treeNoticeRefusalText, type TreeEdgeAnswer, type TreeEdgeAsk, type TreeNoticeAnswer, type TreeNoticeRefusal } from "@mako/protocol/tree-notices"
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
   * `passive`: a look that never wakes a cloud Thread's machine asleep; it answers at once that it sleeps.
   */
  call(target: PlaceTarget, channel: string, args: readonly Json[], how?: { passive?: boolean }): Promise<Json | undefined>
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
  committedSource: z.literal(1).optional(),
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
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
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

/**
 * How a post of a notice to the account went: its answer, with how long a `rate` refusal said to wait; `unauthorized`
 * when the account no longer takes this machine's credential (it rotated, or the machine is being enrolled again);
 * `unserved` from an account with no path for a device's notices; `failed` when no answer came that can be read (the
 * network, or the account failing).
 */
export type NoticePosted =
  | { kind: "answered"; answer: TreeNoticeAnswer; retryAfterMs?: number }
  | { kind: "unauthorized" }
  | { kind: "unserved" }
  | { kind: "failed"; why: string }

/**
 * A cloud machine's way to its Fin's Apex (`AgentsDeps.post`): the account, which holds each notice for the Apex's
 * Session and delivers it to whoever owns that Session. `body` is the notice's JSON text, as the account counts it.
 */
export interface NoticePost {
  post(body: string): Promise<NoticePosted>
}

/**
 * A device's way to the account for its trees (`AgentsDeps.tree`): the record of each Fin it placed elsewhere, kept
 * and ended there (`TreeEdgeAskSchema`), and the notices of Fins here whose Apex's device keeps such a record. `open`:
 * whether this device's link agreed the version whose account holds notices (`TREE_NOTICES_LINK_VERSION`). Until it
 * has, nothing is asked or posted, and a notice goes to its Apex's device.
 */
export interface TreeAccount extends NoticePost {
  open(): boolean
  /** An ask of the account's records, answered; `unserved` from an account that keeps none. */
  edge(ask: TreeEdgeAsk): Promise<TreeEdgeAnswer | "unserved">
}

/** The refusals no later post answers otherwise: the report is posted no more (`TreeNoticeRefusalSchema`). */
const REFUSED_FOR_GOOD: ReadonlySet<TreeNoticeRefusal> = new Set(["conflict", "invalid", "forbidden", "too-large"])

/** How one notice went to its Apex's device: that device has it or never will (`taken`), the account refused it for good, or it waits. */
type Direct =
  | { kind: "taken"; fields: Record<string, string | number | boolean> }
  | { kind: "refused"; reason: TreeNoticeRefusal }
  | Waits

/**
 * Not taken yet. `fin`: what holds it is this Fin's alone (its share of its Apex's Session, its rate, or its Apex's
 * device's answer to this notice), so the Fin's later notices wait behind it and every other Fin's go on. Without it,
 * the way itself is out (the network, the account, a device that isn't connected), and nothing more is sent that way.
 */
type Waits = { kind: "waits"; why: string; waitMs?: number; fin?: true }

/**
 * How one notice went: as `Direct`, or `unrecorded` from a device's post, when the account has no record of the Fin or
 * keeps none at all. The account says so only while it holds nothing of that Fin's (`decideTreeEdge`), so the notice
 * goes to its Apex's device with none of the Fin's before it still on its way.
 */
type Sent = Direct | { kind: "unrecorded"; why: string }

export interface AgentPlacesDeps {
  link: PlaceLink
  jobs: HostJobs
  /** The notices no Apex's device has taken yet, oldest first, each on an edge whose Apex is on another device. */
  waiting(): OutboxNotice[]
  /** The Apex's device took it, or will never take it (a stale owner's): it leaves the outbox. */
  taken(report: Report, at: number): void
  /**
   * On a cloud machine: where its notices go, in place of the Apex's device's runtime. A machine has no device's
   * sign-in to call another device with, and the account holds a notice while the Apex's device is off.
   */
  post?: NoticePost
  /**
   * On a device: the account, for a Fin whose Apex's device keeps a record of it there (`RemoteParent.account`). It
   * holds a notice while that device is off, which the device's own runtime can't.
   */
  account?: TreeAccount
  /** The account refused a report's notice for good: it leaves the outbox unheard, and is never marked taken. */
  refused?(report: Report, reason: TreeNoticeRefusal, at: number): void
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
 * kept here but when each device is next tried. On a cloud machine each is posted to the account instead
 * (`NoticePost`), which holds it for the Apex's Session: admitted there, it's taken here. A device posts one to the
 * account too where the Fin's Apex's device keeps a record of the Fin there (`way`), so the two devices needn't be on
 * at once.
 *
 * A Fin's notices reach its Apex in the order they were made, and the two ways never carry one Fin's at once. The
 * outbox sends an Apex's device's notices one at a time, each answered before the next leaves. A call to that device
 * is answered once the device has the notice. A post is answered once the account holds it, which may be long before
 * the device takes it, so a notice goes to the device itself after a post only when the account said it has no record
 * of the Fin (`unrecorded`), which it says only while it holds nothing of that Fin's.
 */
export class AgentPlaces {
  private readonly deps: AgentPlacesDeps
  private readonly rooms = new Map<string, Room>()
  /** By Apex device: when its notices are next tried, and how long the wait after that is. */
  private readonly retries = new Map<string, Retry>()
  /**
   * By Fin: when the notices of a Fin that waited for itself alone (`Waits.fin`) are next tried, and how long the wait
   * after that is. Apart from `retries`, so a Fin waiting out its own share or rate never holds back a sibling's notice,
   * which goes at once, and a sibling's going doesn't post the waiting Fin's again before its time.
   */
  private readonly finRetries = new Map<string, Retry>()
  private readonly flushing = new Map<string, Promise<void>>()
  private readonly again = new Set<string>()
  /**
   * By report: a standing said again while that report was still in the outbox, its latest. The report's own post says
   * how the Fin stands as it leaves, so one asked for before it leaves is said by it; one asked for while it's on its
   * way is said once it's taken (`send`), since what that post carries is from before.
   */
  private readonly restated = new Map<string, OutboxNotice>()
  /** The account said it has no path for a device's notices: it's posted none until this device's link is next up (`linked`). */
  private pathless = false
  /** The Fins whose notices went to their Apex's device for want of the account's record, said as a warning once each. */
  private readonly unrecordedSaid = new Set<string>()
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
    if (input.workspace.source) {
      const offers = await this.capabilities(target, name)
      if ("refused" in offers) return offers
      if (offers.committedSource !== 1) return { refused: "unsupported", why: `${name} cannot verify committed Fin sources. Update Mako there before placing this source.` }
    }
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
    if (input.workspace.source && (!placed.success || placed.data.sourceSha256 !== input.workspace.source.sha256))
      return { lost: "The placed Fin's source receipt did not match; its outcome must be recovered under the same operation." }
    if (!placed.success) return { refused: "unavailable", why: `${name} answered the start with something this Mako can't read: ${z.prettifyError(placed.error)}` }
    // SAFETY: PlacedAnswerSchema holds every field of AgentsPlaced to its type; `state` is one of ChildState's kinds.
    return placed.data as AgentsPlaced
  }

  /**
   * One of an Apex's operations on a Fin it placed (`mako:agents-<verb>`), answered by the Fin's device as it answers
   * its own Apexes, with this Apex as the caller. A refusal comes back as one; a place that can't be reached is one too.
   * `passive`: a look that leaves a cloud Thread's machine asleep (`PlaceLink.call`).
   */
  async ask<Answer extends object>(target: PlaceTarget, channel: string, caller: ApexCaller, input: PlacedAsk, what: string, passive = false): Promise<Answer | AwayRefused> {
    try {
      const answer = await this.deps.link.call(target, channel, [wire(caller), wire(input)], passive ? { passive } : undefined)
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
    const post = this.way(notice.edge)
    // Still in the outbox: it goes in its turn behind any before it, and says how the Fin stands then, or after (`restated`).
    if (post && this.deps.waiting().some(({ report }) => report.id === notice.report.id)) {
      this.restated.set(notice.report.id, notice)
      return this.queued(device)
    }
    const input = this.noticeOf(notice)
    const direct = () => this.deps.link.call({ kind: "device", device, name: device }, "mako:agents-notice", [wire(input)]).then(
      () => hostLog("agents", "standing sent", { notice: input.id, device, working: input.standing?.working ?? false }),
      (error: Error) => hostLog("agents", "standing not sent", { notice: input.id, device, why: errorMessage({ error }) }),
    )
    if (!post) return void direct()
    // Admitted before: the account puts the newer standing on the notice it holds, or sends it on to the owner once.
    this.posted(post, input).then(
      (sent) => {
        // No record of the Fin there, so nothing of its is held there: its Apex's device is told itself.
        if (sent.kind === "unrecorded") return direct()
        hostLog("agents", sent.kind === "taken" ? "standing sent" : "standing not sent", { notice: input.id, working: input.standing?.working ?? false, ...(sent.kind === "taken" ? sent.fields : { why: sent.kind === "refused" ? sent.reason : sent.why }) })
      },
      (error: Error) => hostLog("agents", "standing not sent", { notice: input.id, why: errorMessage({ error }) }),
    )
  }

  /**
   * Where a Fin's notices are posted, or undefined when they go to its Apex's device itself. A cloud machine posts
   * every one. A device posts a Fin's only where its Apex's device said it keeps a record of the Fin with the account
   * (`RemoteParent.account`) and this device's link agreed that the account holds notices: without either, an older
   * device or an older account, the notice goes as it always did.
   */
  private way(edge: ThreadParent): NoticePost | undefined {
    if (this.deps.post) return this.deps.post
    return edge.remote?.account && !this.pathless && this.deps.account?.open() ? this.deps.account : undefined
  }

  private noticeOf({ edge, report }: OutboxNotice): AgentsNoticeInput {
    return { id: `notice:${edge.child}:${report.id}`, op: edge.op, parent: { thread: edge.parent, session: edge.parentSession }, child: edge.child, report, standing: this.deps.standing(edge, report) }
  }

  /** How many notices wait for an Apex's device to take them, for Diagnostics. */
  pending(): number {
    return this.deps.waiting().length
  }

  /**
   * Whether a notice is on its way to the account from this machine: a post under way, or one that waits a retry
   * still short of the longest. That is work its machine stays up for (`MachineRuntimeOptions.work`), so it isn't
   * paused with a report half sent. An outbox with nothing in it holds nothing up, and nor does one the account has
   * turned away for as long as the waits grow: what's kept goes when the machine next runs.
   */
  posting(): boolean {
    if (!this.deps.post || this.stopped) return false
    if (this.flushing.size) return true
    for (const retry of [...this.retries.values(), ...this.finRetries.values()]) if (retry.waitMs < OUTBOX_RETRY_MAX_MS) return true
    return false
  }

  /** This machine's credential was renewed, or its link is up: what the account turned away with the old one goes now. */
  renewed(): void {
    if (!this.deps.post || this.stopped) return
    this.retries.clear()
    this.finRetries.clear()
    this.resume()
  }

  /** This device is back on its account: what waited for the account, or for a device that may be back as well, goes now. */
  linked(): void {
    if (this.deps.post || this.stopped) return
    this.pathless = false
    this.retries.clear()
    this.finRetries.clear()
    this.resume()
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
    // A wait for a device nothing waits for any more is over: it holds nothing (`posting`).
    for (const device of this.retries.keys()) if (!devices.has(device) && !this.flushing.has(device)) this.retries.delete(device)
    const fins = new Set<string>(waiting.map(({ edge }) => edge.child))
    for (const child of this.finRetries.keys()) if (!fins.has(child)) this.finRetries.delete(child)
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

  /**
   * One pass over what waits for `device`, oldest first. A notice that waits for its Fin alone (`Waits.fin`) holds back
   * that Fin's later notices, which keep their order behind it, and no other Fin's: one Fin at its share of its Apex's
   * Session, or at its rate, never keeps a sibling's report, or another tree's, from going. A wait for the way itself
   * ends the pass. Either way the device is tried again after the wait.
   */
  private async send(device: string): Promise<void> {
    /** Fins whose earlier notice waits: their later ones wait behind it. */
    const held = new Set<string>()
    for (const { edge, report } of this.deps.waiting()) {
      if (this.stopped) return
      if (edge.remote?.device !== device || held.has(edge.child)) continue
      // A Fin waiting out its own wait isn't posted again before its time, whatever else goes.
      if ((this.finRetries.get(edge.child)?.at ?? 0) > this.now()) {
        held.add(edge.child)
        continue
      }
      // What this post says of how the Fin stands is as it is now: a standing asked for before it is said by it.
      this.restated.delete(report.id)
      const input = this.noticeOf({ edge, report })
      const id = input.id
      const began = this.now()
      const post = this.way(edge)
      const posted = post ? await this.posted(post, input) : undefined
      if (posted?.kind === "unrecorded") this.unrecorded(edge.child, id, device, posted.why)
      const sent = !posted || posted.kind === "unrecorded" ? await this.called(device, input) : posted
      if (sent.kind === "waits" && !sent.fin) return this.wait(device, id, sent.why, sent.waitMs)
      if (sent.kind === "waits") {
        held.add(edge.child)
        const again = later(this.finRetries.get(edge.child), sent.waitMs, this.now())
        this.finRetries.set(edge.child, again)
        hostLog("agents", "notice waits for its Fin alone", { notice: id, child: edge.child, device, why: sent.why, againInMs: again.at - this.now() })
        continue
      }
      this.retries.delete(device)
      this.finRetries.delete(edge.child)
      if (sent.kind === "refused") {
        // Nothing this host posts again answers otherwise, and nothing its Fin does mends it: it's kept unheard, out
        // of the outbox, and said here alone. The Fin's later reports go on behind it.
        this.deps.refused?.(report, sent.reason, this.now())
        this.restated.delete(report.id)
        hostWarn("agents", "notice refused for good", { notice: id, child: edge.child, device, refused: sent.reason, why: treeNoticeRefusalText(sent.reason) })
        continue
      }
      this.deps.taken(report, this.now())
      hostLog("agents", "notice sent", { notice: id, device, ms: this.now() - began, ...sent.fields })
      // The Fin stood otherwise while this was on its way, which what it carried can't say: said now, once.
      const after = this.restated.get(report.id)
      if (after) {
        this.restated.delete(report.id)
        this.restate(after)
      }
    }
    this.retries.delete(device)
    // What waits for its Fin alone is tried again on the outbox's job.
    this.demand.set(this.deps.waiting().length > 0)
  }

  /**
   * A Fin's notice goes to its Apex's device itself, since the account has no record of the Fin (its Apex's device
   * never kept one, or it lapsed while that device was away): it reaches its Apex only while that device is on. Said
   * as a warning the first time for each Fin, and in the log after. The Apex's device, hearing a Fin it had on record
   * from the Fin's device, asks the account to keep the record again (`Agents.recordLost`), so it mends itself.
   */
  private unrecorded(child: string, notice: string, device: string, why: string): void {
    const fields = { notice, child, device, why, so: "it reaches its Apex only while its Apex's device is on" }
    if (this.unrecordedSaid.has(child)) return hostLog("agents", "notice goes to its Apex's device", fields)
    this.unrecordedSaid.add(child)
    hostWarn("agents", "notice goes to its Apex's device", fields)
  }

  /** One notice to its Apex's device's runtime, as a device sends it. */
  private async called(device: string, input: AgentsNoticeInput): Promise<Direct> {
    let answer: AgentsNoticed
    try {
      const parsed = NoticedSchema.safeParse(await this.deps.link.call({ kind: "device", device, name: device }, "mako:agents-notice", [wire(input)]))
      answer = !parsed.success ? { refused: "unavailable", why: "Its device answered something this Mako can't read." } : "refused" in parsed.data ? asRefused(parsed.data) : parsed.data
    } catch (error) {
      return { kind: "waits", why: error instanceof OwnerUnavailableError && !error.unconfirmed ? "its device isn't connected" : errorMessage({ error }) }
    }
    // The device answered: what it refused is this notice's, and the way is open for the rest.
    if ("refused" in answer && answer.refused !== "stale-owner") return { kind: "waits", why: `${answer.refused}: ${answer.why}`, ...(answer.refused !== "unavailable" && { fin: true as const }) }
    return { kind: "taken", fields: "refused" in answer ? { refused: answer.refused } : answer.deduped ? { deduped: true } : {} }
  }

  /**
   * One notice posted to the account: what a notice says and no more (`TreeNoticeSchema`), so no `op`, which the
   * account says itself from this sender's credential. Admitted, the account holds it for the Apex's Session, which
   * is the Apex's device taking it as far as this host goes; a repeat answers the number it had. `gone` is as good as
   * taken, since nothing is left to hear it. `rate` and `full` pass. The rest never do, but for a device's
   * `forbidden`: the account has no record of the Fin (`unrecorded`), as an account with no path for it has none.
   */
  private async posted(post: NoticePost, input: AgentsNoticeInput): Promise<Sent> {
    const notice = { id: input.id, parent: input.parent, child: input.child, report: input.report, ...(input.standing && { standing: input.standing }) }
    let went: NoticePosted
    try {
      went = await post.post(JSON.stringify(notice))
    } catch (error) {
      went = { kind: "failed", why: errorMessage({ error }) }
    }
    if (went.kind === "failed") return { kind: "waits", why: went.why }
    const device = post !== this.deps.post
    if (went.kind === "unserved") {
      if (!device) return { kind: "waits", why: "the account has no path for this machine's notices" }
      this.pathless = true
      return { kind: "unrecorded", why: "the account has no path for a device's notices" }
    }
    // Its credential is renewed by the machine's agent, and what waits goes as it is (`renewed`): until then, the longest wait.
    if (went.kind === "unauthorized") return { kind: "waits", why: "the account no longer takes this machine's credential", waitMs: OUTBOX_RETRY_MAX_MS }
    const answer = went.answer
    if (answer.admitted) return { kind: "taken", fields: { seq: answer.seq } }
    if (answer.reason === "gone") return { kind: "taken", fields: { refused: answer.reason } }
    if (device && answer.reason === "forbidden") return { kind: "unrecorded", why: "the account has no record of this Fin" }
    if (REFUSED_FOR_GOOD.has(answer.reason)) return { kind: "refused", reason: answer.reason }
    const waitMs = answer.reason === "rate" && went.retryAfterMs !== undefined ? Math.min(OUTBOX_RETRY_MAX_MS, Math.max(1_000, went.retryAfterMs)) : undefined
    // `rate` and `full` are the Fin's own: its posts in the minute, its share of its Apex's Session.
    return { kind: "waits", why: `${answer.reason}: ${treeNoticeRefusalText(answer.reason)}`, ...(waitMs !== undefined && { waitMs }), fin: true }
  }

  /**
   * Not taken: it stays in the outbox, and its device is tried again later, each wait twice the last. `named` is a
   * wait the answer set itself: a short one leaves the doubling where it was, and the longest takes it there.
   */
  private wait(device: string, notice: string, why: string, named?: number): void {
    const again = later(this.retries.get(device), named, this.now())
    const againInMs = again.at - this.now()
    this.retries.set(device, again)
    this.demand.set(true)
    hostLog("agents", "notice waits", { notice, device, why, againInMs })
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}

/** When what waits is next tried, and how long the wait after that is. */
type Retry = { at: number; waitMs: number }

/**
 * The next try after one more that wasn't taken, from the wait before it: twice that wait, from `OUTBOX_RETRY_MS` up to
 * `OUTBOX_RETRY_MAX_MS`. `named` is a wait the answer set itself: a short one leaves the doubling where it was, and the
 * longest takes it there.
 */
function later(before: Retry | undefined, named: number | undefined, now: number): Retry {
  const was = before?.waitMs ?? OUTBOX_RETRY_MS / 2
  const waitMs = named === undefined ? Math.min(OUTBOX_RETRY_MAX_MS, was * 2) : named < OUTBOX_RETRY_MAX_MS ? was : OUTBOX_RETRY_MAX_MS
  return { at: now + (named ?? waitMs), waitMs }
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
