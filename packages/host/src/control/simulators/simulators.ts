import type { SetupConsent } from "../../contracts/simulator-setup.js"
import {
  AFTER_OPEN,
  CLAIM_IDLE_MS,
  type ListedSimulator,
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
import { hostLog } from "../../base/host-log.js"
import { SimulatorUnsupported, type SimulatorHost } from "./host.js"

/** The person, when they take a simulator from the panel: a holder like any Thread, so an agent's late action is stale. */
const PERSON = "person"

/**
 * The simulators every host here can run, and who drives each: one Thread at a time, everyone else watching. Each
 * claim has a generation, and a Thread that lost one (released, idle past `CLAIM_IDLE_MS`, or taken over by the
 * person) is refused as `stale`, so its late action can't land on someone else's screen. Agents are refused until
 * the person allows simulators in their project. Every decision is a `simulators` line in host.log.
 */
export class Simulators {
  readonly #hosts: ReadonlyMap<string, SimulatorHost>
  readonly #consent: () => Promise<SetupConsent[]>
  readonly #now: () => number
  readonly #claims = new Map<string, SimulatorClaim>()
  /** By simulator, the Threads that held it and lost it since. */
  readonly #lost = new Map<string, Set<string>>()
  #generation = 0

  constructor(options: { hosts: readonly SimulatorHost[]; consent: () => Promise<SetupConsent[]>; now?: () => number }) {
    this.#hosts = new Map(options.hosts.map((host) => [host.id, host]))
    this.#consent = options.consent
    this.#now = options.now ?? Date.now
  }

  async list(caller: SimulatorCaller): Promise<SimulatorsListed> {
    const hosts = [...this.#hosts.values()]
    const [summaries, lists, consent] = await Promise.all([
      Promise.all(hosts.map((host) => host.summary())),
      Promise.all(hosts.map((host) => host.list().catch(() => []))),
      this.#consentFor(caller),
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
    const { host, simulator } = found
    const id = key(host.id, simulator.id)
    const holder = this.#claim(id)
    const thread = threadOf(caller)
    if (holder && holder.thread !== thread && caller.kind === "agent") return this.#refuse("open", caller, id, { refused: "held", why: `${holder.title ?? "Another Thread"} drives this simulator. Wait for it to be released, or ask the person to hand it over.`, holder })
    const done = await this.#perform("open", caller, id, async () => {
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
            ...(caller.kind === "agent" && { conversation: caller.conversation, ...(caller.title && { title: caller.title }) }),
            ...(caller.kind === "person" && { title: "You" }),
            since: now,
            lastAt: now,
            generation: ++this.#generation,
          }
    this.#claims.set(id, claim)
    this.#lost.get(id)?.delete(thread)
    hostLog("simulators", "open", { ...who(caller), simulator: id, generation: claim.generation, ...(holder && holder.thread !== thread && { took: holder.thread }) })
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
    const refused = await this.#perform("shot", caller, key(found.host.id, found.simulator.id), async () => {
      shot = await found.host.screenshot(found.simulator.id)
    })
    return refused ?? shot ?? { refused: "unsupported", why: "The host took no picture." }
  }

  async record(caller: SimulatorCaller, input: SimulatorsRecordInput): Promise<SimulatorsRecordResult> {
    return this.#held(caller, "record", input, (host, simulator) => host.record(simulator, input.recording))
  }

  async release(caller: SimulatorCaller, input: SimulatorsReleaseInput): Promise<SimulatorsReleaseResult> {
    const id = key(input.host ?? "local", input.simulator)
    const holder = this.#claim(id)
    const thread = threadOf(caller)
    if (!holder) return { released: false }
    if (holder.thread !== thread && caller.kind === "agent") return this.#refuse("release", caller, id, { refused: "held", why: `${holder.title ?? "Another Thread"} drives this simulator, not this Thread.`, holder })
    this.#lose(id, holder.thread)
    hostLog("simulators", "release", { ...who(caller), simulator: id, generation: holder.generation })
    return { released: true }
  }

  /** A Thread archived or stopped lets go of whatever it holds. */
  releaseThread(thread: string): void {
    for (const [id, claim] of this.#claims) if (claim.thread === thread) {
      this.#lose(id, thread)
      hostLog("simulators", "release", { thread, simulator: id, generation: claim.generation, why: "thread ended" })
    }
  }

  async #held<Result extends object>(
    caller: SimulatorCaller,
    verb: string,
    input: { simulator: string; host?: string },
    work: (host: SimulatorHost, simulator: string) => Promise<Result>
  ): Promise<Result | SimulatorRefused> {
    const found = await this.#find(caller, verb, input)
    if ("refused" in found) return found
    const id = key(found.host.id, found.simulator.id)
    const holder = this.#claim(id)
    const thread = threadOf(caller)
    if (!holder || holder.thread !== thread) {
      if (this.#lost.get(id)?.has(thread)) return this.#refuse(verb, caller, id, { refused: "stale", why: `This Thread no longer drives this simulator${holder ? `: ${holder.title ?? "another Thread"} does` : ""}. Open it again before acting.`, ...(holder && { holder }) })
      if (holder && caller.kind === "agent") return this.#refuse(verb, caller, id, { refused: "held", why: `${holder.title ?? "Another Thread"} drives this simulator.`, holder })
      if (!holder) return this.#refuse(verb, caller, id, { refused: "not-open", why: "Open it with simulator_open first; that takes it for this Thread." })
    }
    if (holder) this.#claims.set(id, { ...holder, lastAt: this.#now() })
    let result: Result | undefined
    const refused = await this.#perform(verb, caller, id, async () => {
      result = await work(found.host, found.simulator.id)
    })
    return refused ?? result ?? { refused: "unsupported", why: "The host answered nothing." }
  }

  async #find(caller: SimulatorCaller, verb: string, input: { simulator: string; host?: string }) {
    const id = key(input.host ?? "local", input.simulator)
    if (caller.kind === "agent" && (await this.#consentFor(caller)) !== "allowed")
      return this.#refuse(verb, caller, id, { refused: "not-allowed", why: "The person hasn't allowed simulators in this project. They can in Settings › Simulators." })
    const host = this.#hosts.get(input.host ?? "local")
    if (!host) return this.#refuse(verb, caller, id, { refused: "not-found", why: `No host here is called ${input.host}.` })
    const simulator = (await host.list()).find((entry) => entry.id === input.simulator)
    if (!simulator) {
      const ios = (await host.summary()).platforms.ios
      return this.#refuse(verb, caller, id, ios.ready ? { refused: "not-found", why: `${host.label} has no simulator ${input.simulator}; simulator_list names them.` } : { refused: "unavailable", why: ios.why })
    }
    return { host, simulator }
  }

  /** Runs a host's operation, its refusal (`SimulatorUnsupported`) said as one; anything else is a failure and thrown. */
  async #perform(verb: string, caller: SimulatorCaller, id: string, work: () => Promise<void>): Promise<SimulatorRefused | undefined> {
    const started = this.#now()
    try {
      await work()
      hostLog("simulators", verb, { ...who(caller), simulator: id, ms: this.#now() - started })
      return undefined
    } catch (error) {
      if (error instanceof SimulatorUnsupported) return this.#refuse(verb, caller, id, { refused: "unsupported", why: error.message })
      throw error
    }
  }

  #refuse(verb: string, caller: SimulatorCaller, id: string, refused: SimulatorRefused): SimulatorRefused {
    hostLog("simulators", "refused", { verb, ...who(caller), simulator: id, reason: refused.refused, ...(refused.holder && { holder: refused.holder.thread }) })
    return refused
  }

  #claim(id: string): SimulatorClaim | undefined {
    const claim = this.#claims.get(id)
    if (claim && claim.thread !== PERSON && this.#now() - claim.lastAt >= CLAIM_IDLE_MS) {
      this.#lose(id, claim.thread)
      hostLog("simulators", "release", { thread: claim.thread, simulator: id, generation: claim.generation, why: "idle" })
      return undefined
    }
    return claim
  }

  #lose(id: string, thread: string): void {
    this.#claims.delete(id)
    const lost = this.#lost.get(id) ?? new Set<string>()
    lost.add(thread)
    this.#lost.set(id, lost)
  }

  async #consentFor(caller: SimulatorCaller): Promise<SimulatorConsent> {
    if (caller.kind === "person") return "allowed"
    const answer = (await this.#consent()).find((entry) => caller.folder === entry.folder || caller.folder.startsWith(`${entry.folder}/`))
    return answer ? (answer.allowed ? "allowed" : "refused") : "unasked"
  }
}

function key(host: string, simulator: string): string {
  return `${host}:${simulator}`
}

function threadOf(caller: SimulatorCaller): string {
  return caller.kind === "agent" ? caller.thread : PERSON
}

function who(caller: SimulatorCaller): Record<string, string> {
  return caller.kind === "agent" ? { thread: caller.thread, conversation: caller.conversation } : { caller: PERSON }
}
