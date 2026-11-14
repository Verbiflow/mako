import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import { encodeControlVideoBatch } from "@mako/control-runtime/contracts"
import { z } from "zod"
import type { SetupConsent } from "../../contracts/simulator-setup.js"
import {
  AFTER_OPEN,
  CLAIM_IDLE_MS,
  SHOT_INLINE_LIMIT,
  WATCH_WAIT_MS,
  type ListedSimulator,
  type SimulatorAgent,
  type SimulatorCaller,
  type SimulatorClaim,
  type SimulatorConsent,
  type SimulatorHostSummary,
  type SimulatorRefused,
  type SimulatorsActInput,
  type SimulatorsActResult,
  type SimulatorsListed,
  type SimulatorsOpenInput,
  type SimulatorsOpenResult,
  type SimulatorsReadInput,
  type SimulatorsReadResult,
  type SimulatorsRecordInput,
  type SimulatorsRecordResult,
  type SimulatorsReleaseInput,
  type SimulatorsReleaseResult,
  type SimulatorsShot,
  type SimulatorsShotInput,
  type SimulatorsShotResult,
  type SimulatorsWatchInput,
  type SimulatorsWatchResult,
  type SimulatorVia,
  type SimulatorArtifact,
} from "../../contracts/simulators.js"
import { hostLog, hostWarn } from "../../base/host-log.js"
import { MACHINE_CLIENT, NOT_THE_PERSON } from "../../base/host-client.js"
import { SimulatorUnsupported, type RemoteSimulatorHost, type SimulatorHost } from "./host.js"
import { SimulatorStreams, type ViewerOwner } from "./stream.js"

/** The person, when they take a simulator from the panel: a holder like any Thread, so an agent's late action is stale. */
const PERSON = "person"

/** A caller once the host has found its Session's Thread. */
type Who = ({ kind: "agent" } & SimulatorAgent) | { kind: "person" }

/** Which Thread ended, by whichever of its names the ending knows. */
export type EndedThread = { thread?: string; conversation?: string; session?: string }

const NOT_LEASED = "This Mac lends its simulators only under a lease of your Thread. Borrow an iOS simulator first; it's routed to a Mac that has one free."
const OTHER_LEASE = "This simulator is held under another of your Thread's leases; each lease drives only the simulator it opened."

/** A call from another place under a lease this Mac serves: the lease, and what it heard of it, for its session's progress. */
export interface SimulatorLeases {
  /** The live lease the call is under: one of the calling Thread's, from where the gateway says it came. */
  leaseOf(via: SimulatorVia, thread: string): string | undefined
  /** A verb ran under the lease, for its session's progress. */
  used?(lease: string, verb: string): void
  /** A file made under the lease (a large picture, a recording), given to it for its borrower: sealed, by hash. */
  artifact?(lease: string, file: string, name: string): Promise<SimulatorArtifact>
}

/**
 * The simulators every host here can run, and who drives each: one Thread at a time, everyone else watching. Each
 * claim has a generation, and a Thread that lost one (released, idle past `CLAIM_IDLE_MS`, or taken over by the
 * person) is refused as `stale`, so its late action can't land on someone else's screen. Agents are refused until
 * the person allows simulators in their project. Every decision is a `simulators` line in host.log.
 *
 * Another Mac's simulators (`remotes`) are that Mac's to decide: a call for one is checked against this Mac's
 * project consent, then handed on whole with the Thread this Mac already resolved, and its claim is kept there. A
 * call that came here from another place (`via`) is answered only for this Mac's own simulators: the person's from
 * another of their devices, and an agent's only under a live session lease of its Thread that this Mac serves
 * (`leases`), checked on every call.
 */
/** A cloud Thread's borrowed simulators, as the list asks for one and a stopping host lets them go (`BorrowedSimulators`). */
export interface SimulatorsBorrowing {
  ensure(why: string): Promise<SimulatorHostSummary | undefined>
  close?(): Promise<void>
}

export class Simulators {
  readonly #hosts: ReadonlyMap<string, SimulatorHost>
  readonly #remotes: () => readonly RemoteSimulatorHost[]
  readonly #borrowing: SimulatorsBorrowing | undefined
  readonly #consent: () => Promise<SetupConsent[]>
  /** The one simulator each lease lends, from its first open until its claim ends. */
  readonly #leased = new Map<string, string>()
  readonly #leases: SimulatorLeases | undefined
  readonly #agent: (session: string) => SimulatorAgent | undefined
  readonly #now: () => number
  readonly #holding: (on: boolean) => void
  readonly #streams: SimulatorStreams
  readonly #claims = new Map<string, SimulatorClaim>()
  /** By simulator, the Threads that held it and lost it since. */
  readonly #lost = new Map<string, Set<string>>()
  #generation = 0

  constructor(options: {
    hosts: readonly SimulatorHost[]
    consent: () => Promise<SetupConsent[]>
    /** The Thread, conversation, title and folder of a Session on this host, as the Thread store and its conversation say. */
    agent: (session: string) => SimulatorAgent | undefined
    /** The person's other Macs, as they are now: the account's devices come and go. */
    remotes?: () => readonly RemoteSimulatorHost[]
    /** The leases this Mac serves, which an agent's call from another place must be under; without them, none is. */
    leases?: SimulatorLeases
    /**
     * On a cloud Thread's machine: its simulators are a Mac of the person's borrowed under a session lease. The first
     * look asks for one, and how that stands is a host in the list; the person's grant is the consent there.
     */
    borrowing?: SimulatorsBorrowing
    now?: () => number
    /** Whether any simulator is held, as it changes: the idle sweep runs only while one is. */
    holding?: (on: boolean) => void
    streams?: SimulatorStreams
  }) {
    this.#hosts = new Map(options.hosts.map((host) => [host.id, host]))
    this.#remotes = options.remotes ?? (() => [])
    this.#consent = options.consent
    this.#leases = options.leases
    this.#borrowing = options.borrowing
    this.#agent = options.agent
    this.#now = options.now ?? Date.now
    this.#holding = options.holding ?? (() => undefined)
    this.#streams = options.streams ?? new SimulatorStreams({ now: this.#now })
  }

  async list(caller: SimulatorCaller): Promise<SimulatorsListed | SimulatorRefused> {
    const who = this.#who(caller, "list")
    if ("refused" in who) return who
    const consent = await this.#consentFor(who, caller)
    if (caller.via && consent !== "allowed") return { hosts: await this.#notOffered(), simulators: [], consent }
    const hosts = [...this.#hosts.values()]
    const waiting = !caller.via && who.kind === "agent" ? await this.#borrowing?.ensure(`${who.title ?? "This Thread"} looks for a simulator`) : undefined
    // Another device hears this Mac's own simulators alone: it reaches the account's other Macs itself.
    const remotes = caller.via ? [] : this.#remotes()
    const [summaries, lists, others] = await Promise.all([
      Promise.all(hosts.map((host) => host.summary())),
      Promise.all(hosts.map((host) => host.list().catch(() => []))),
      Promise.all(remotes.map((remote) => remote.list(this.#handed(caller, who)))),
    ])
    const simulators = lists.flat().map((simulator): ListedSimulator => {
      const claim = this.#claim(key(simulator.hostId, simulator.id))
      return claim ? { ...simulator, claim } : simulator
    })
    return { hosts: [...summaries, ...others.flatMap((other) => other.hosts), ...(waiting ? [waiting] : [])], simulators: [...simulators, ...others.flatMap((other) => other.simulators)], consent }
  }

  async open(caller: SimulatorCaller, input: SimulatorsOpenInput): Promise<SimulatorsOpenResult> {
    const remote = await this.#remote(caller, "open", input)
    if (remote) return "refused" in remote ? remote : remote.host.open(remote.caller, input)
    const found = await this.#find(caller, "open", input)
    if ("refused" in found) return found
    const { who, host, simulator, lease } = found
    const id = key(host.id, simulator.id)
    const holder = this.#claim(id)
    const thread = threadOf(who)
    const bound = lease ? this.#leased.get(lease) : undefined
    if (lease && bound && bound !== id) return this.#refuse("open", who, id, { refused: "not-offered", why: `A lease lends one simulator, and this one's is ${unkey(bound)[1]}. Release it before opening another.` })
    if (lease && holder?.thread === thread && holder.lease !== lease) return this.#refuse("open", who, id, { refused: "not-offered", why: OTHER_LEASE })
    if (holder && holder.thread !== thread && who.kind === "agent") return this.#refuse("open", who, id, { refused: "held", why: `${holder.title ?? "Another Thread"} drives this simulator. Wait for it to be released, or ask the person to hand it over.`, holder })
    const done = await this.#perform("open", who, id, async () => {
      await host.boot(simulator.id)
      if (input.url) await host.act(simulator.id, { kind: "open-url", url: input.url })
    })
    if (done) return done
    const now = this.#now()
    if (holder && holder.thread !== thread) this.#lose(id, holder.thread)
    const claim: SimulatorClaim =
      holder?.thread === thread
        ? { ...holder, lastAt: now }
        : {
            thread,
            ...(who.kind === "agent" && { session: who.session, ...(who.conversation && { conversation: who.conversation }), ...(who.title && { title: who.title }) }),
            ...(who.kind === "person" && { title: "You" }),
            since: now,
            lastAt: now,
            generation: ++this.#generation,
            ...(lease && { lease }),
          }
    this.#claims.set(id, claim)
    if (lease) this.#leased.set(lease, id)
    this.#holding(true)
    this.#lost.get(id)?.delete(thread)
    hostLog("simulators", "open", { ...whoLog(who, caller), simulator: id, generation: claim.generation, ...(holder && holder.thread !== thread && { took: holder.thread }) })
    return { simulator: { ...simulator, claim }, claim, next: AFTER_OPEN }
  }

  async act(caller: SimulatorCaller, input: SimulatorsActInput): Promise<SimulatorsActResult> {
    const remote = await this.#remote(caller, "act", input)
    if (remote) return "refused" in remote ? remote : remote.host.act(remote.caller, input)
    // A drag's moves come at the display's rate: its begin and end are logged, not each move.
    const quiet = input.action.kind === "touch" && input.action.phase === "move"
    return this.#held(
      caller,
      "act",
      input,
      async (host, simulator) => {
        const started = this.#now()
        await host.act(simulator, input.action)
        return { ms: this.#now() - started }
      },
      quiet
    )
  }

  async read(caller: SimulatorCaller, input: SimulatorsReadInput): Promise<SimulatorsReadResult> {
    const remote = await this.#remote(caller, "read", input)
    if (remote) return "refused" in remote ? remote : remote.host.read(remote.caller, input)
    return this.#held(caller, "read", input, async (host, simulator) => ({ what: input.what, ...(await host.read(simulator, input.what, input.after)) }))
  }

  /** A shot is a look, so a watcher may take one too; it says nothing about who drives. */
  async shot(caller: SimulatorCaller, input: SimulatorsShotInput): Promise<SimulatorsShotResult> {
    const remote = await this.#remote(caller, "shot", input)
    if (remote) return "refused" in remote ? remote : remote.host.shot(remote.caller, input)
    const found = await this.#find(caller, "shot", input)
    if ("refused" in found) return found
    let shot: SimulatorsShot | undefined
    const refused = await this.#perform("shot", found.who, key(found.host.id, found.simulator.id), async () => {
      shot = await found.host.screenshot(found.simulator.id)
      if (input.inline) shot = await inlined(shot)
      // Too large to go inline to a caller under a lease: the picture goes to the lease, and the caller fetches it.
      if (input.inline && shot && !shot.inline && found.lease && this.#leases?.artifact) shot = { ...shot, artifact: await this.#leases.artifact(found.lease, shot.path, basename(shot.path)) }
    })
    return refused ?? shot ?? { refused: "unsupported", why: "The host took no picture." }
  }

  async record(caller: SimulatorCaller, input: SimulatorsRecordInput): Promise<SimulatorsRecordResult> {
    const remote = await this.#remote(caller, "record", input)
    if (remote) return "refused" in remote ? remote : remote.host.record(remote.caller, input)
    return this.#held(caller, "record", input, async (host, simulator, lease) => {
      const recorded = await host.record(simulator, input.recording)
      // A recording for a caller under a lease goes to that lease: its file on this Mac means nothing there.
      if (!lease || !recorded.path || !this.#leases?.artifact) return recorded
      return { artifact: await this.#leases.artifact(lease, recorded.path, basename(recorded.path)) }
    })
  }

  async release(caller: SimulatorCaller, input: SimulatorsReleaseInput): Promise<SimulatorsReleaseResult> {
    const remote = await this.#remote(caller, "release", input)
    if (remote) return "refused" in remote ? remote : remote.host.release(remote.caller, input)
    const who = this.#who(caller, "release")
    if ("refused" in who) return who
    const id = key(input.host, input.simulator)
    // Another place's agent names its Thread itself (the gateway stamps only where it came from): it releases only
    // under a live lease of that Thread from there, and only that lease's own claim.
    const lease = caller.via && who.kind === "agent" ? this.#leases?.leaseOf(caller.via, who.thread) : undefined
    if (caller.via && who.kind === "agent" && !lease) return this.#refuse("release", who, id, { refused: "not-offered", why: NOT_LEASED })
    const holder = this.#claim(id)
    const thread = threadOf(who)
    if (!holder) return { released: false }
    if (holder.thread !== thread && who.kind === "agent") return this.#refuse("release", who, id, { refused: "held", why: `${holder.title ?? "Another Thread"} drives this simulator, not this Thread.`, holder })
    if (lease && holder.lease !== lease) return this.#refuse("release", who, id, { refused: "not-offered", why: OTHER_LEASE })
    this.#end(id, holder, { ...whoLog(who, caller) })
    return { released: true }
  }

  /**
   * A viewer's next packets of a simulator's screen, which anyone may watch. Its name is scoped by where it called
   * from and by whose it is, so a phone's viewer and a panel's, or two Threads', can't take each other's stream.
   */
  async watch(caller: SimulatorCaller, input: SimulatorsWatchInput): Promise<SimulatorsWatchResult> {
    const remote = await this.#remote(caller, "watch", input)
    if (remote) return "refused" in remote ? remote : remote.host.watch(remote.caller, input)
    const found = await this.#find(caller, "watch", input)
    if ("refused" in found) return found
    const { who, host, simulator } = found
    const frames = host.frames?.bind(host)
    if (!frames) return this.#refuse("watch", who, key(host.id, simulator.id), { refused: "unsupported", why: `${host.label} can't stream a simulator's screen yet; simulator_shot takes a picture of it.` })
    const viewer = `${caller.via?.from ?? "here"}/${threadOf(who)}/${input.viewer}`
    if (input.leave) {
      this.#streams.leave(key(host.id, simulator.id), viewer)
      return { live: false, batch: Buffer.from(encodeControlVideoBatch({ live: false, packets: [] })).toString("base64") }
    }
    const read = await this.#streams.read(key(host.id, simulator.id), viewer, (sink) => frames(simulator.id, sink), {
      ...(input.box && { box: input.box }),
      ...(input.decoded !== undefined && { decoded: input.decoded }),
      ...(who.kind === "agent" && { owner: { thread: who.thread, session: who.session, ...(who.conversation && { conversation: who.conversation }) } }),
      waitMs: Math.min(Math.max(input.waitMs ?? WATCH_WAIT_MS, 0), WATCH_WAIT_MS),
    })
    return { live: read.live, batch: Buffer.from(encodeControlVideoBatch(read)).toString("base64") }
  }

  /** A Thread archived lets go of whatever it holds, and stops watching: a screen nobody else watches stops streaming. */
  releaseThread(ended: EndedThread): void {
    const owned = (owner: ViewerOwner) =>
      Boolean((ended.thread && owner.thread === ended.thread) || (ended.conversation && owner.conversation === ended.conversation) || (ended.session && owner.session === ended.session))
    for (const [id, claim] of this.#claims) if (owned(claim)) this.#end(id, claim, { thread: claim.thread, why: "thread ended" })
    this.#streams.leaveOwned(owned)
  }

  /** A lease this Mac served ended: the claim made under it lets go, and no other, the same Thread's included. */
  releaseLease(lease: string): void {
    for (const [id, claim] of this.#claims) if (claim.lease === lease) this.#end(id, claim, { thread: claim.thread, lease, why: "lease ended" })
    this.#leased.delete(lease)
  }

  /** Ends every claim idle past `CLAIM_IDLE_MS`, so a billed host stops on time and not when someone next looks. */
  sweep(): void {
    for (const id of this.#claims.keys()) this.#claim(id)
  }

  /** Every screen stops streaming, every host stops what it started, and what this host borrowed is released. */
  async close(): Promise<void> {
    await this.#borrowing?.close?.()
    await this.#streams.close()
    await Promise.all([...this.#hosts.values()].map((host) => host.close().catch((error) => hostWarn("simulators", "host close failed", { host: host.id, error: error instanceof Error ? error.message : String(error) }))))
  }

  /**
   * The other Mac a call names, once this Mac's consent lets its agent use it; undefined for this Mac's own hosts. A
   * call from another device may name only this Mac's own: it reaches the account's other Macs itself.
   */
  async #remote(
    caller: SimulatorCaller,
    verb: string,
    input: { simulator: string; host: string }
  ): Promise<{ host: RemoteSimulatorHost; caller: SimulatorCaller } | SimulatorRefused | undefined> {
    if (this.#hosts.has(input.host)) return undefined
    const id = key(input.host, input.simulator)
    const who = this.#who(caller, verb)
    if ("refused" in who) return who
    if (caller.via) return this.#refuse(verb, who, id, { refused: "not-found", why: `This Mac has no host called ${input.host}.` })
    const remote = this.#remotes().find((each) => each.id === input.host)
    if (!remote) return undefined
    if (who.kind === "agent" && (await this.#consentFor(who, caller)) !== "allowed")
      return this.#refuse(verb, who, id, { refused: "not-allowed", why: "The person hasn't allowed simulators in this project. They can in Settings › Simulators." })
    hostLog("simulators", "handed on", { verb, ...whoLog(who, caller), simulator: id })
    return { host: remote, caller: this.#handed(caller, who) }
  }

  /** The caller as another Mac hears it: an agent carries the Thread this Mac already resolved. */
  #handed(caller: SimulatorCaller, who: Who): SimulatorCaller {
    if (who.kind === "person") return { kind: "person", ...(caller.via && { via: caller.via }) }
    return { kind: "agent", session: who.session, agent: who, ...(caller.via && { via: caller.via }) }
  }

  async #held<Result extends object>(
    caller: SimulatorCaller,
    verb: string,
    input: { simulator: string; host: string },
    work: (host: SimulatorHost, simulator: string, lease?: string) => Promise<Result>,
    quiet = false
  ): Promise<Result | SimulatorRefused> {
    const found = await this.#find(caller, verb, input)
    if ("refused" in found) return found
    const { who } = found
    const id = key(found.host.id, found.simulator.id)
    const holder = this.#claim(id)
    const thread = threadOf(who)
    if (!holder || holder.thread !== thread) {
      if (this.#lost.get(id)?.has(thread)) return this.#refuse(verb, who, id, { refused: "stale", why: `This Thread no longer drives this simulator${holder ? `: ${holder.title ?? "another Thread"} does` : ""}. Open it again before acting.`, ...(holder && { holder }) })
      if (holder && who.kind === "agent") return this.#refuse(verb, who, id, { refused: "held", why: `${holder.title ?? "Another Thread"} drives this simulator.`, holder })
      if (!holder) return this.#refuse(verb, who, id, { refused: "not-open", why: "Open it with simulator_open first; that takes it for this Thread." })
    }
    if (found.lease && holder?.lease !== found.lease) return this.#refuse(verb, who, id, { refused: "not-offered", why: OTHER_LEASE })
    if (holder?.thread === thread) this.#claims.set(id, { ...holder, lastAt: this.#now() })
    let result: Result | undefined
    const refused = await this.#perform(
      verb,
      who,
      id,
      async () => {
        result = await work(found.host, found.simulator.id, found.lease)
      },
      quiet
    )
    return refused ?? result ?? { refused: "unsupported", why: "The host answered nothing." }
  }

  async #find(caller: SimulatorCaller, verb: string, input: { simulator: string; host: string }) {
    const who = this.#who(caller, verb)
    if ("refused" in who) return who
    const id = key(input.host, input.simulator)
    let lease: string | undefined
    if (caller.via && who.kind === "agent") {
      lease = this.#leases?.leaseOf(caller.via, who.thread)
      if (!lease) return this.#refuse(verb, who, id, { refused: "not-offered", why: NOT_LEASED })
      this.#leases?.used?.(lease, verb)
    }
    if (who.kind === "agent" && !caller.via && (await this.#consentFor(who, caller)) !== "allowed")
      return this.#refuse(verb, who, id, { refused: "not-allowed", why: "The person hasn't allowed simulators in this project. They can in Settings › Simulators." })
    const host = this.#hosts.get(input.host)
    if (!host) return this.#refuse(verb, who, id, { refused: "not-found", why: `No host here is called ${input.host}; simulator_list names them.` })
    const simulator = (await host.list()).find((entry) => entry.id === input.simulator)
    if (!simulator) {
      const ios = (await host.summary()).platforms.ios
      return this.#refuse(verb, who, id, ios.ready ? { refused: "not-found", why: `${host.label} has no simulator ${input.simulator}; simulator_list names them.` } : { refused: "unavailable", why: ios.why })
    }
    return { who, host, simulator, ...(lease && { lease }) }
  }

  /**
   * An agent's Session as the host knows it; the caller names only the Session. A call from another Mac already
   * carries the Thread that Mac resolved (`agent`); this Mac has no Session of its own for it.
   */
  #who(caller: SimulatorCaller, verb: string): Who | SimulatorRefused {
    if (caller.via) {
      // A machine runtime is never the person, whatever its payload says; it reaches a simulator as its Thread, leased.
      if (caller.kind === "person" && `gateway:${caller.via.from}`.startsWith(MACHINE_CLIENT)) {
        hostLog("simulators", "refused", { verb, reason: "machine-as-person", via: caller.via.from })
        return { refused: "not-offered", why: NOT_THE_PERSON }
      }
      if (caller.kind === "person") return { kind: "person" }
      if (caller.agent) return { kind: "agent", ...caller.agent }
      hostLog("simulators", "refused", { verb, session: caller.session, reason: "no-thread", via: caller.via.from })
      return { refused: "no-thread", why: "The calling Mac didn't say which Thread that Session belongs to." }
    }
    if (caller.kind === "person") return caller
    const agent = this.#agent(caller.session)
    if (agent) return { kind: "agent", ...agent }
    hostLog("simulators", "refused", { verb, session: caller.session, reason: "no-thread" })
    return { refused: "no-thread", why: "No Thread on this Mac has that Session; call from a Thread's mako tools, or its shell, where MAKO_SESSION_ID names it." }
  }

  /** Runs a host's operation, its refusal (`SimulatorUnsupported`) said as one; anything else is a failure and thrown. */
  async #perform(verb: string, who: Who, id: string, work: () => Promise<void>, quiet = false): Promise<SimulatorRefused | undefined> {
    const started = this.#now()
    try {
      await work()
      if (!quiet) hostLog("simulators", verb, { ...whoLog(who), simulator: id, ms: this.#now() - started })
      return undefined
    } catch (error) {
      if (error instanceof SimulatorUnsupported) return this.#refuse(verb, who, id, { refused: "unsupported", why: error.message })
      throw error
    }
  }

  #refuse(verb: string, who: Who, id: string, refused: SimulatorRefused): SimulatorRefused {
    hostLog("simulators", "refused", { verb, ...whoLog(who), simulator: id, reason: refused.refused, ...(refused.holder && { holder: refused.holder.thread }) })
    return refused
  }

  #claim(id: string): SimulatorClaim | undefined {
    const claim = this.#claims.get(id)
    if (claim && claim.thread !== PERSON && this.#now() - claim.lastAt >= CLAIM_IDLE_MS) {
      this.#end(id, claim, { thread: claim.thread, why: "idle" })
      return undefined
    }
    return claim
  }

  /** A claim ends with nobody taking it: its host hears so, which stops a billed session. */
  #end(id: string, claim: SimulatorClaim, log: Record<string, string>): void {
    this.#lose(id, claim.thread)
    hostLog("simulators", "release", { ...log, simulator: id, generation: claim.generation })
    const [hostId, simulator] = unkey(id)
    void this.#hosts.get(hostId)?.release(simulator).catch((error) => hostWarn("simulators", "host release failed", { simulator: id, error: error instanceof Error ? error.message : String(error) }))
  }

  #lose(id: string, thread: string): void {
    const lease = this.#claims.get(id)?.lease
    if (lease && this.#leased.get(lease) === id) this.#leased.delete(lease)
    this.#claims.delete(id)
    if (this.#claims.size === 0) this.#holding(false)
    const lost = this.#lost.get(id) ?? new Set<string>()
    lost.add(thread)
    this.#lost.set(id, lost)
  }

  /**
   * An agent here by its project's consent; an agent's call from another place by a live lease of its Thread that this
   * Mac serves, which the person granted for that project; the person from any of their devices. The most specific
   * answer for where it works, else for its worktree's project: a subfolder decided on overrides its project's.
   */
  async #consentFor(who: Who, caller?: SimulatorCaller): Promise<SimulatorConsent> {
    if (who.kind === "person") return "allowed"
    if (caller?.via) return this.#leases?.leaseOf(caller.via, who.thread) ? "allowed" : "refused"
    // A cloud Thread's simulators are borrowed: the person's grant, decided at the broker, is the consent.
    if (this.#borrowing) return "allowed"
    return consentFor(await this.#consent(), who)
  }

  /** This Mac's hosts as a caller without a lease hears them: there, and not lent to it. */
  async #notOffered(): Promise<SimulatorHostSummary[]> {
    const blocked = { ready: false as const, blocker: "not-offered" as const, why: NOT_LEASED }
    return Promise.all([...this.#hosts.values()].map(async (host) => ({ ...(await host.summary()), platforms: { ios: blocked, android: blocked } })))
  }
}

/** A picture with its bytes, for a caller on another Mac, when they're small enough to cross in an answer. */
async function inlined(shot: SimulatorsShot): Promise<SimulatorsShot> {
  const bytes = await readFile(shot.path)
  if (bytes.byteLength > SHOT_INLINE_LIMIT) return shot
  const type = /\.jpe?g$/i.test(shot.path) ? "image/jpeg" : "image/png"
  return { ...shot, inline: { type, data: bytes.toString("base64") } }
}

/** The person's answer for where an agent works: the nearest folder they answered for, then its worktree's project. */
export function consentFor(consent: readonly SetupConsent[], agent: Pick<SimulatorAgent, "folder" | "project">): SimulatorConsent {
  const answerFor = (folder: string) =>
    consent.filter((entry) => folder === entry.folder || folder.startsWith(`${entry.folder}/`)).sort((left, right) => right.folder.length - left.folder.length)[0]
  const answer = answerFor(agent.folder) ?? (agent.project ? answerFor(agent.project) : undefined)
  return answer ? (answer.allowed ? "allowed" : "refused") : "unasked"
}

/** A host ID may hold colons (`mac:<device>`), so the pair is kept as JSON. */
function key(host: string, simulator: string): string {
  return JSON.stringify([host, simulator])
}

const Key = z.tuple([z.string(), z.string()])

function unkey(id: string): [string, string] {
  return Key.parse(JSON.parse(id))
}

function threadOf(who: Who): string {
  return who.kind === "agent" ? who.thread : PERSON
}

function whoLog(who: Who, caller?: SimulatorCaller): Record<string, string> {
  return who.kind === "agent"
    ? { thread: who.thread, session: who.session, ...(who.conversation && { conversation: who.conversation }), ...(caller?.via && { via: caller.via.from }) }
    : { caller: PERSON, ...(caller?.via && { via: caller.via.from }) }
}
