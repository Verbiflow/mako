import { z } from "zod"
import type { SetupConsent } from "../../contracts/simulator-setup.js"
import {
  AFTER_OPEN,
  CLAIM_IDLE_MS,
  type ListedSimulator,
  type SimulatorAgent,
  type SimulatorCaller,
  type SimulatorClaim,
  type SimulatorConsent,
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
} from "../../contracts/simulators.js"
import { hostLog, hostWarn } from "../../base/host-log.js"
import { SimulatorUnsupported, type SimulatorHost } from "./host.js"

/** The person, when they take a simulator from the panel: a holder like any Thread, so an agent's late action is stale. */
const PERSON = "person"

/** A caller once the host has found its Session's Thread. */
type Who = ({ kind: "agent" } & SimulatorAgent) | { kind: "person" }

/** Which Thread ended, by whichever of its names the ending knows. */
export type EndedThread = { thread?: string; conversation?: string; session?: string }

/**
 * The simulators every host here can run, and who drives each: one Thread at a time, everyone else watching. Each
 * claim has a generation, and a Thread that lost one (released, idle past `CLAIM_IDLE_MS`, or taken over by the
 * person) is refused as `stale`, so its late action can't land on someone else's screen. Agents are refused until
 * the person allows simulators in their project. Every decision is a `simulators` line in host.log.
 */
export class Simulators {
  readonly #hosts: ReadonlyMap<string, SimulatorHost>
  readonly #consent: () => Promise<SetupConsent[]>
  readonly #agent: (session: string) => SimulatorAgent | undefined
  readonly #now: () => number
  readonly #holding: (on: boolean) => void
  readonly #claims = new Map<string, SimulatorClaim>()
  /** By simulator, the Threads that held it and lost it since. */
  readonly #lost = new Map<string, Set<string>>()
  #generation = 0

  constructor(options: {
    hosts: readonly SimulatorHost[]
    consent: () => Promise<SetupConsent[]>
    /** The Thread, conversation, title and folder of a Session on this host, as the Thread store and its conversation say. */
    agent: (session: string) => SimulatorAgent | undefined
    now?: () => number
    /** Whether any simulator is held, as it changes: the idle sweep runs only while one is. */
    holding?: (on: boolean) => void
  }) {
    this.#hosts = new Map(options.hosts.map((host) => [host.id, host]))
    this.#consent = options.consent
    this.#agent = options.agent
    this.#now = options.now ?? Date.now
    this.#holding = options.holding ?? (() => undefined)
  }

  async list(caller: SimulatorCaller): Promise<SimulatorsListed | SimulatorRefused> {
    const who = this.#who(caller, "list")
    if ("refused" in who) return who
    const hosts = [...this.#hosts.values()]
    const [summaries, lists, consent] = await Promise.all([
      Promise.all(hosts.map((host) => host.summary())),
      Promise.all(hosts.map((host) => host.list().catch(() => []))),
      this.#consentFor(who),
    ])
    const simulators = lists.flat().map((simulator): ListedSimulator => {
      const claim = this.#claim(key(simulator.hostId, simulator.id))
      return claim ? { ...simulator, claim } : simulator
    })
    return { hosts: summaries, simulators, consent }
  }

  async open(caller: SimulatorCaller, input: SimulatorsOpenInput): Promise<SimulatorsOpenResult> {
    const found = await this.#find(caller, "open", input)
    if ("refused" in found) return found
    const { who, host, simulator } = found
    const id = key(host.id, simulator.id)
    const holder = this.#claim(id)
    const thread = threadOf(who)
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
          }
    this.#claims.set(id, claim)
    this.#holding(true)
    this.#lost.get(id)?.delete(thread)
    hostLog("simulators", "open", { ...whoLog(who), simulator: id, generation: claim.generation, ...(holder && holder.thread !== thread && { took: holder.thread }) })
    return { simulator: { ...simulator, claim }, claim, next: AFTER_OPEN }
  }

  async act(caller: SimulatorCaller, input: SimulatorsActInput): Promise<SimulatorsActResult> {
    return this.#held(caller, "act", input, async (host, simulator) => {
      const started = this.#now()
      await host.act(simulator, input.action)
      return { ms: this.#now() - started }
    })
  }

  async read(caller: SimulatorCaller, input: SimulatorsReadInput): Promise<SimulatorsReadResult> {
    return this.#held(caller, "read", input, async (host, simulator) => ({ what: input.what, ...(await host.read(simulator, input.what, input.after)) }))
  }

  /** A shot is a look, so a watcher may take one too; it says nothing about who drives. */
  async shot(caller: SimulatorCaller, input: SimulatorsShotInput): Promise<SimulatorsShotResult> {
    const found = await this.#find(caller, "shot", input)
    if ("refused" in found) return found
    let shot: SimulatorsShot | undefined
    const refused = await this.#perform("shot", found.who, key(found.host.id, found.simulator.id), async () => {
      shot = await found.host.screenshot(found.simulator.id)
    })
    return refused ?? shot ?? { refused: "unsupported", why: "The host took no picture." }
  }

  async record(caller: SimulatorCaller, input: SimulatorsRecordInput): Promise<SimulatorsRecordResult> {
    return this.#held(caller, "record", input, (host, simulator) => host.record(simulator, input.recording))
  }

  async release(caller: SimulatorCaller, input: SimulatorsReleaseInput): Promise<SimulatorsReleaseResult> {
    const who = this.#who(caller, "release")
    if ("refused" in who) return who
    const id = key(input.host, input.simulator)
    const holder = this.#claim(id)
    const thread = threadOf(who)
    if (!holder) return { released: false }
    if (holder.thread !== thread && who.kind === "agent") return this.#refuse("release", who, id, { refused: "held", why: `${holder.title ?? "Another Thread"} drives this simulator, not this Thread.`, holder })
    this.#end(id, holder, { ...whoLog(who) })
    return { released: true }
  }

  /** A Thread archived lets go of whatever it holds. */
  releaseThread(ended: EndedThread): void {
    for (const [id, claim] of this.#claims)
      if ((ended.thread && claim.thread === ended.thread) || (ended.conversation && claim.conversation === ended.conversation) || (ended.session && claim.session === ended.session))
        this.#end(id, claim, { thread: claim.thread, why: "thread ended" })
  }

  /** Ends every claim idle past `CLAIM_IDLE_MS`, so a billed host stops on time and not when someone next looks. */
  sweep(): void {
    for (const id of this.#claims.keys()) this.#claim(id)
  }

  /** Every host stops what it started. */
  async close(): Promise<void> {
    await Promise.all([...this.#hosts.values()].map((host) => host.close().catch((error) => hostWarn("simulators", "host close failed", { host: host.id, error: error instanceof Error ? error.message : String(error) }))))
  }

  async #held<Result extends object>(
    caller: SimulatorCaller,
    verb: string,
    input: { simulator: string; host: string },
    work: (host: SimulatorHost, simulator: string) => Promise<Result>
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
    if (holder?.thread === thread) this.#claims.set(id, { ...holder, lastAt: this.#now() })
    let result: Result | undefined
    const refused = await this.#perform(verb, who, id, async () => {
      result = await work(found.host, found.simulator.id)
    })
    return refused ?? result ?? { refused: "unsupported", why: "The host answered nothing." }
  }

  async #find(caller: SimulatorCaller, verb: string, input: { simulator: string; host: string }) {
    const who = this.#who(caller, verb)
    if ("refused" in who) return who
    const id = key(input.host, input.simulator)
    if (who.kind === "agent" && (await this.#consentFor(who)) !== "allowed")
      return this.#refuse(verb, who, id, { refused: "not-allowed", why: "The person hasn't allowed simulators in this project. They can in Settings › Simulators." })
    const host = this.#hosts.get(input.host)
    if (!host) return this.#refuse(verb, who, id, { refused: "not-found", why: `No host here is called ${input.host}; simulator_list names them.` })
    const simulator = (await host.list()).find((entry) => entry.id === input.simulator)
    if (!simulator) {
      const ios = (await host.summary()).platforms.ios
      return this.#refuse(verb, who, id, ios.ready ? { refused: "not-found", why: `${host.label} has no simulator ${input.simulator}; simulator_list names them.` } : { refused: "unavailable", why: ios.why })
    }
    return { who, host, simulator }
  }

  /** An agent's Session as the host knows it; the caller names only the Session. */
  #who(caller: SimulatorCaller, verb: string): Who | SimulatorRefused {
    if (caller.kind === "person") return caller
    const agent = this.#agent(caller.session)
    if (agent) return { kind: "agent", ...agent }
    hostLog("simulators", "refused", { verb, session: caller.session, reason: "no-thread" })
    return { refused: "no-thread", why: "No Thread on this Mac has that Session; call from a Thread's mako tools, or its shell, where MAKO_SESSION_ID names it." }
  }

  /** Runs a host's operation, its refusal (`SimulatorUnsupported`) said as one; anything else is a failure and thrown. */
  async #perform(verb: string, who: Who, id: string, work: () => Promise<void>): Promise<SimulatorRefused | undefined> {
    const started = this.#now()
    try {
      await work()
      hostLog("simulators", verb, { ...whoLog(who), simulator: id, ms: this.#now() - started })
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
    this.#claims.delete(id)
    if (this.#claims.size === 0) this.#holding(false)
    const lost = this.#lost.get(id) ?? new Set<string>()
    lost.add(thread)
    this.#lost.set(id, lost)
  }

  /** The most specific answer for where it works, else for its worktree's project: a subfolder decided on overrides its project's. */
  async #consentFor(who: Who): Promise<SimulatorConsent> {
    if (who.kind === "person") return "allowed"
    const consent = await this.#consent()
    const answerFor = (folder: string) =>
      consent.filter((entry) => folder === entry.folder || folder.startsWith(`${entry.folder}/`)).sort((left, right) => right.folder.length - left.folder.length)[0]
    const answer = answerFor(who.folder) ?? (who.project ? answerFor(who.project) : undefined)
    return answer ? (answer.allowed ? "allowed" : "refused") : "unasked"
  }
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

function whoLog(who: Who): Record<string, string> {
  return who.kind === "agent" ? { thread: who.thread, session: who.session, ...(who.conversation && { conversation: who.conversation }) } : { caller: PERSON }
}
