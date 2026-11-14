import { SESSION_HEARTBEAT_MS, type Artifact, type BorrowAnswer, type Lease, type LeaseEnd, type Progress, type SourceAnswer, type SourceAsk, type Stream } from "@mako/protocol/borrow"
import { HeldLeases } from "../base/held-leases.js"
import type { LentHere } from "../base/lent.js"
import type { SimulatorVia } from "../contracts/simulators.js"

/** How often a served session says it's alive: well inside its lease's window, so one late beat never loses it. */
export const LEND_BEAT_MS = SESSION_HEARTBEAT_MS / 2

export interface LendingDeps {
  /** This device in the account, as leases name it; undefined while signed out. */
  device(): Promise<string | undefined>
  /** Answers an ask on the account's routes, the broker's decision back. */
  answer(ask: string, answer: SourceAnswer): Promise<BorrowAnswer | undefined>
  /** The account's live leases as its broker lists them; null where there's no broker to ask. */
  leases(): Promise<Lease[] | null>
  /** Whether this device can serve what an ask names now: yes with a version, or why not. */
  serve(ask: SourceAsk): Promise<SourceAnswer>
  /** Says a served session is alive on the runtime link, with its streams until a beat with them is heard; false while the link is down or older. */
  beat(lease: string, progress?: Progress, streams?: Stream[]): boolean
  /** What a served lease's session streams its borrower: a simulator's screen. */
  streams?(lease: Lease): Stream[]
  lent: LentHere
  /** A served lease in Settings' words: what it is, and for whom. */
  words(lease: Lease): { what: string; for: string }
  /** A file a served session made, given to its lease on the account's routes: sealed there, listed by name and hash. */
  upload?(lease: string, file: string, name: string): Promise<Artifact>
  /** A served lease ended: whatever it holds here lets go (a simulator's claim). */
  ended?(lease: Lease, why: LeaseEnd): void
  now?(): number
  log?(message: string, fields: Record<string, string | number | boolean>): void
}

/**
 * What this device lends under borrowing's session leases, as their source. It answers the asks it can answer itself
 * (an ask that needs its person waits for them in Setup), serves each lease the broker issues it from the moment it
 * hears it, beats for it on its runtime link, and lets go of it however it ends: told by the broker, found ended when
 * it reads the account's leases again on connecting, or at its own expiry, link or no link. A renewal the broker makes
 * is taken wherever it's heard (its word again, the account's list, or asked as the lease nears its end). Every call another place makes to it under a lease is
 * checked here first (`leaseOf`): a live lease of that caller's Thread, from the place the gateway says it came from.
 */
export class Lending {
  readonly #deps: LendingDeps
  /** The leases served, under borrowing's lifecycle rules (`HeldLeases`): ended stays ended, a renewal is taken. */
  readonly #served = new HeldLeases()
  /** Progress said since the last beat, sent with the next one. */
  readonly #progress = new Map<string, Progress>()
  /** Served sessions whose streams no heard beat has said yet: each beat says them until one is heard. */
  readonly #unsaid = new Set<string>()
  /** The phase each served session was last said to be in. */
  readonly #phases = new Map<string, Progress["phase"]>()
  /** The broker being asked for leases near their end; one ask at a time. */
  #renewing: Promise<void> | undefined

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

  /**
   * A lease this device serves: held from now, one of its slots, and alive at once. The same lease again takes no
   * other slot; it only adopts a later expiry, the broker's renewal, and never an earlier one.
   */
  async lent(lease: Lease): Promise<void> {
    if (!lease.session || this.#served.ended(lease.id)) return
    if (lease.device !== (await this.#deps.device())) return
    const taken = this.#served.take(lease, this.#now())
    if (taken === "renewed") this.#deps.log?.("a served lease was renewed", { lease: lease.id, expiresAt: lease.expiresAt })
    if (taken !== "held") return
    const words = this.#deps.words(lease)
    this.#deps.lent.add({ lease: lease.id, what: words.what, for: words.for, since: this.#now() })
    this.#deps.log?.("serving a lease", { lease: lease.id, ref: lease.resource.ref, thread: lease.borrower.thread })
    if (this.#deps.streams?.(lease).length) this.#unsaid.add(lease.id)
    this.#say(lease.id)
  }

  /** A served lease ended, however it ended: its slot is free, and what it held here lets go. */
  ended(lease: string, why: LeaseEnd): void {
    const held = this.#served.end(lease)
    if (held) this.#let(held, why)
  }

  /** One beat for a served session: its progress since the last heard one, and its streams until a beat says them. */
  #say(id: string): void {
    const lease = this.#served.get(id)
    if (!lease) return
    const progress = this.#progress.get(id)
    const streams = this.#unsaid.has(id) ? this.#deps.streams?.(lease) : undefined
    if (!this.#deps.beat(id, progress, streams?.length ? streams : undefined)) return
    this.#progress.delete(id)
    this.#unsaid.delete(id)
  }

  /** What a served lease held here lets go, once it has ended. */
  #let(held: Lease, why: LeaseEnd): void {
    this.#unsaid.delete(held.id)
    this.#progress.delete(held.id)
    this.#phases.delete(held.id)
    this.#deps.lent.remove(held.id)
    this.#deps.log?.("a served lease ended", { lease: held.id, why })
    this.#deps.ended?.(held, why)
  }

  /**
   * As the runtime link enrols: the account's live leases are the truth. One this device serves that's still live is
   * served, at the expiry listed when that's later; one it served when the read began that isn't listed ended while it
   * was away, and lets go as lost. One issued while the list was read is newer than the list, and stays.
   */
  async sync(): Promise<void> {
    const since = this.#served.begin()
    const live = await this.#deps.leases().catch(() => null)
    if (!live) return
    const device = await this.#deps.device()
    const mine = live.filter((lease) => lease.device === device && lease.session)
    for (const held of this.#served.heldBefore(since)) if (!mine.some((lease) => lease.id === held.id)) this.ended(held.id, "lost")
    for (const lease of mine) await this.lent(lease)
  }

  /** How far a served session is, said with its next beat (now). */
  progress(lease: string, progress: Progress): void {
    if (!this.#served.has(lease)) return
    this.#progress.set(lease, progress)
    this.#say(lease)
  }

  /** A file a served session made, for its borrower: only under a lease this device serves now. */
  async artifact(lease: string, file: string, name: string): Promise<Artifact> {
    if (!this.#served.has(lease) || !this.#deps.upload) throw new Error("No lease this Mac serves takes that file")
    const made = await this.#deps.upload(lease, file, name)
    this.#deps.log?.("gave a lease a file", { lease, size: made.size })
    return made
  }

  /** A verb ran under a served lease: opening reads as booting, anything after as running, said when it changes. */
  used(lease: string, verb: string): void {
    const phase = verb === "open" ? "booting" : "running"
    if (this.#phases.get(lease) === phase) return
    this.#phases.set(lease, phase)
    this.progress(lease, { phase })
  }

  /**
   * Every served session beats: the job that runs it runs every `LEND_BEAT_MS`. One past its expiry ends here, as
   * expired, whether or not the link is up to say so; one within two beats of it is asked of the broker, which may have
   * renewed it.
   */
  beat(): void {
    const now = this.#now()
    for (const lease of this.#served.expired(now)) this.#let(lease, "expired")
    for (const { id } of this.#served.leases()) this.#say(id)
    if (this.#served.leases().some((lease) => lease.expiresAt - 2 * LEND_BEAT_MS <= now)) void this.#renew()
  }

  /**
   * The live lease a call from another place is under: one this device serves, for `resource`, of the Thread the call
   * names, from the place the gateway stamped it as coming from. Undefined for any other call, which is refused.
   */
  leaseOf(via: SimulatorVia, thread: string, resource: string): Lease | undefined {
    for (const lease of this.#served.leases()) {
      if (lease.resource.ref !== resource || lease.borrower.thread !== thread || lease.expiresAt <= this.#now()) continue
      if (fromPlace(via, lease)) return lease
    }
    return undefined
  }

  served(): Lease[] {
    return this.#served.leases()
  }

  /** The broker's list asked for renewals of leases near their end; a lease it no longer lists is left to expire or sync. */
  #renew(): Promise<void> {
    this.#renewing ??= (async () => {
      const live = await this.#deps.leases().catch(() => null)
      for (const lease of live ?? []) if (this.#served.has(lease.id) && this.#served.take(lease, this.#now()) === "renewed") this.#deps.log?.("a served lease was renewed", { lease: lease.id, expiresAt: lease.expiresAt })
    })().finally(() => {
      this.#renewing = undefined
    })
    return this.#renewing
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
