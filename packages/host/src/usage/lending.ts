import { SESSION_HEARTBEAT_MS, type BorrowAnswer, type Lease, type LeaseEnd, type Progress, type SourceAnswer, type SourceAsk, type Stream } from "@mako/protocol/borrow"
import type { LentHere } from "../base/lent.js"
import type { SimulatorVia } from "../contracts/simulators.js"

/** How often a served session says it's alive: well inside its lease's window, so one late beat never loses it. */
export const LEND_BEAT_MS = SESSION_HEARTBEAT_MS / 2
/** How many ended leases are remembered against late word of their issue. */
const ENDED_KEPT = 256

export interface LendingDeps {
  /** This device in the account, as leases name it; undefined while signed out. */
  device(): Promise<string | undefined>
  /** Answers an ask on the account's routes, the broker's decision back. */
  answer(ask: string, answer: SourceAnswer): Promise<BorrowAnswer | undefined>
  /** The account's live leases as its broker lists them; null where there's no broker to ask. */
  leases(): Promise<Lease[] | null>
  /** Whether this device can serve what an ask names now: yes with a version, or why not. */
  serve(ask: SourceAsk): Promise<SourceAnswer>
  /** Says a served session is alive on the runtime link, with its streams when they're first said; false while the link is down or older. */
  beat(lease: string, progress?: Progress, streams?: Stream[]): boolean
  /** What a served lease's session streams its borrower: a simulator's screen. */
  streams?(lease: Lease): Stream[]
  lent: LentHere
  /** A served lease in Settings' words: what it is, and for whom. */
  words(lease: Lease): { what: string; for: string }
  /** A served lease ended: whatever it holds here lets go (a simulator's claim). */
  ended?(lease: Lease, why: LeaseEnd): void
  now?(): number
  log?(message: string, fields: Record<string, string | number | boolean>): void
}

/**
 * What this device lends under borrowing's session leases, as their source. It answers the asks it can answer itself
 * (an ask that needs its person waits for them in Setup), serves each lease the broker issues it from the moment it
 * hears it, beats for it on its runtime link, and lets go of it however it ends: told by the broker, or found ended
 * when it reads the account's leases again on connecting. Every call another place makes to it under a lease is
 * checked here first (`leaseOf`): a live lease of that caller's Thread, from the place the gateway says it came from.
 */
export class Lending {
  readonly #deps: LendingDeps
  readonly #served = new Map<string, Lease>()
  /** Progress said since the last beat, sent with the next one. */
  readonly #progress = new Map<string, Progress>()
  /** Leases already ended here, so word of one issued that arrives after its end serves nothing. */
  readonly #ended = new Set<string>()
  /** The phase each served session was last said to be in. */
  readonly #phases = new Map<string, Progress["phase"]>()

  constructor(deps: LendingDeps) {
    this.#deps = deps
  }

  /** An ask for this device as a source: answered at once when its person isn't asked; else Setup shows it to them. */
  async asked(ask: SourceAsk): Promise<void> {
    if (ask.askPerson) return this.#deps.log?.("an ask waits for the person", { ask: ask.ask, ref: ask.ref })
    const answer = await this.#deps.serve(ask).catch((): SourceAnswer => ({ answer: "unavailable", reason: "error" }))
    const decided = await this.#deps.answer(ask.ask, answer).catch((error: Error) => {
      this.#deps.log?.("an ask's answer didn't reach the account", { ask: ask.ask, error: error.message })
      return undefined
    })
    this.#deps.log?.("answered an ask", { ask: ask.ask, ref: ask.ref, answer: answer.answer })
    if (decided && "lease" in decided) await this.lent(decided.lease)
  }

  /** A lease this device serves: held from now, one of its slots, and alive at once. The same lease again changes nothing. */
  async lent(lease: Lease): Promise<void> {
    if (!lease.session || this.#ended.has(lease.id)) return
    if (lease.device !== (await this.#deps.device())) return
    if (this.#served.has(lease.id) || this.#ended.has(lease.id)) return
    this.#served.set(lease.id, lease)
    const words = this.#deps.words(lease)
    this.#deps.lent.add({ lease: lease.id, what: words.what, for: words.for, since: this.#now() })
    this.#deps.log?.("serving a lease", { lease: lease.id, ref: lease.resource.ref, thread: lease.borrower.thread })
    const streams = this.#deps.streams?.(lease)
    this.#deps.beat(lease.id, undefined, streams?.length ? streams : undefined)
  }

  /** A served lease ended, however it ended: its slot is free, and what it held here lets go. */
  ended(lease: string, why: LeaseEnd): void {
    this.#ended.add(lease)
    if (this.#ended.size > ENDED_KEPT) this.#ended.delete(this.#ended.values().next().value!)
    const held = this.#served.get(lease)
    if (!held) return
    this.#served.delete(lease)
    this.#progress.delete(lease)
    this.#phases.delete(lease)
    this.#deps.lent.remove(lease)
    this.#deps.log?.("a served lease ended", { lease, why })
    this.#deps.ended?.(held, why)
  }

  /**
   * As the runtime link enrols: the account's live leases are the truth. One this device serves that's still live is
   * served; one it held that isn't listed ended while it was away, and lets go as lost.
   */
  async sync(): Promise<void> {
    const live = await this.#deps.leases().catch(() => null)
    if (!live) return
    const device = await this.#deps.device()
    const mine = live.filter((lease) => lease.device === device && lease.session)
    for (const id of this.#served.keys()) if (!mine.some((lease) => lease.id === id)) this.ended(id, "lost")
    for (const lease of mine) await this.lent(lease)
  }

  /** How far a served session is, said with its next beat (now). */
  progress(lease: string, progress: Progress): void {
    if (!this.#served.has(lease)) return
    this.#progress.set(lease, progress)
    if (this.#deps.beat(lease, progress)) this.#progress.delete(lease)
  }

  /** A verb ran under a served lease: opening reads as booting, anything after as running, said when it changes. */
  used(lease: string, verb: string): void {
    const phase = verb === "open" ? "booting" : "running"
    if (this.#phases.get(lease) === phase) return
    this.#phases.set(lease, phase)
    this.progress(lease, { phase })
  }

  /** Every served session beats: the job that runs it runs every `LEND_BEAT_MS`. */
  beat(): void {
    for (const id of this.#served.keys()) {
      const progress = this.#progress.get(id)
      if (this.#deps.beat(id, progress) && progress) this.#progress.delete(id)
    }
  }

  /**
   * The live lease a call from another place is under: one this device serves, for `resource`, of the Thread the call
   * names, from the place the gateway stamped it as coming from. Undefined for any other call, which is refused.
   */
  leaseOf(via: SimulatorVia, thread: string, resource: string): Lease | undefined {
    for (const lease of this.#served.values()) {
      if (lease.resource.ref !== resource || lease.borrower.thread !== thread || lease.expiresAt <= this.#now()) continue
      if (fromPlace(via, lease)) return lease
    }
    return undefined
  }

  served(): Lease[] {
    return [...this.#served.values()]
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now()
  }
}

/**
 * Whether a call came from where the lease's borrower runs: a machine's runtime (`runtime:m-<id>.g<generation>`, any
 * generation of that machine), or the device itself, through any of its connections.
 */
function fromPlace(via: SimulatorVia, lease: Lease): boolean {
  const place = lease.borrower.place
  if (place.kind === "machine") return via.from === `runtime:${place.machine}` || via.from.startsWith(`runtime:${place.machine}.g`)
  if (via.from === `runtime:d-${place.device}`) return true
  const [kind, device, ...rest] = via.from.split(":")
  return kind !== "runtime" && device === place.device && rest.length === 0
}
