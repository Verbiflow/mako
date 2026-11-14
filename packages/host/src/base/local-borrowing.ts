import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  emptyBroker,
  LeaseEventSchema,
  liveLeases,
  standingGrants,
  step,
  type Actor,
  type BorrowAnswer,
  type BorrowPush,
  type Borrower,
  type Borrowing,
  type BrokerInput,
  type BrokerState,
  type Capability,
  type Grant,
  type Kind,
  type Lease,
  type LeaseEnd,
  type LeaseEvent,
  type Need,
  type Slots,
  type SourceAnswer,
  type SourceAsk,
} from "@mako/protocol/borrow"
import { acquireHostLock } from "./host-lock.js"

/**
 * This device's own broker: the borrowing contract for borrowers on this device, such as a worktree taking files
 * from its project's main checkout or a Thread's harness taking a saved key. It decides by the protocol's one `step`,
 * as the account's broker does, and keeps its state in one file and its lease log as lines of JSON beside it (names
 * and versions, never a value).
 *
 * Every operation holds the folder's lock (kernel-held, so a crash frees it), reads the state as it is on disk, steps
 * and writes it back: any number of brokers over one folder, in one process or several hosts, are one broker, and a
 * revoke one of them made is never undone by another's older copy. Each answers as the source for the kinds it was
 * given; an ask for a kind it can't answer waits in the state for a broker that can.
 *
 * Without a folder it keeps everything in memory: the same decisions, for a host that keeps nothing on disk.
 */
export type SourceFn = (ask: SourceAsk) => Promise<SourceAnswer>

export interface LocalBorrowingOptions {
  /** Where its state, log and lock live; none keeps them in memory. */
  folder?: string
  /** This device's ID, as grants name it as their source. */
  device: string
  /** The account its grants are within; a device that isn't signed in has its own. */
  account: string
  /** What this device says, as a source, of the kinds this broker serves: a version and size, or why not. */
  sources: Partial<Record<Kind, SourceFn>>
  now?: () => number
}

export type PersonAsk = { ask: SourceAsk; at: number }

/** Everything kept on disk: the broker's state, the asks waiting on the person, and asks no source here has answered. */
type Kept = { state: BrokerState; waiting: PersonAsk[]; unanswered: SourceAsk[] }

/** How long an operation waits for the folder's lock before it fails, saying so. */
const LOCK_WAIT_MS = 30_000

export class BorrowingLockTimeout extends Error {
  constructor(folder: string) {
    super(`The device's borrowing state in ${folder} stayed locked for ${LOCK_WAIT_MS / 1000} s`)
    this.name = "BorrowingLockTimeout"
  }
}

export class LocalBorrowing implements Borrowing {
  readonly device: string
  readonly account: string
  readonly folder: string | undefined
  #memory: Kept
  #queue: Promise<unknown> = Promise.resolve()
  #log: LeaseEvent[] = []
  readonly #listeners = new Set<(borrower: Borrower, push: BorrowPush) => void>()
  readonly #options: LocalBorrowingOptions

  constructor(options: LocalBorrowingOptions) {
    this.#options = options
    this.device = options.device
    this.account = options.account
    this.folder = options.folder
    this.#memory = { state: emptyBroker(options.account), waiting: [], unanswered: [] }
  }

  /** Hears every push this broker makes to a borrower here: a lease decided after it waited, ended, or newer at its source. */
  onPush(listener: (borrower: Borrower, push: BorrowPush) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  grant(grant: Grant): Promise<string | undefined> {
    return this.#change(async (kept) => (await this.#step(kept, { type: "grant", grant, at: this.#now() })).rejected)
  }

  borrow(need: Need): Promise<BorrowAnswer> {
    return this.#change(async (kept) => {
      const result = await this.#step(kept, { type: "borrow", need, at: this.#now(), lease: randomUUID(), ask: randomUUID() })
      if (result.rejected || !result.answer) return { refusal: { refused: "unavailable", reason: "error" } }
      return result.answer
    })
  }

  renew(lease: string): Promise<BorrowAnswer> {
    return this.#change(async (kept) => (await this.#step(kept, { type: "renew", lease, at: this.#now() })).answer ?? { refusal: { refused: "unavailable", reason: "error" } })
  }

  release(lease: string): Promise<void> {
    return this.#change(async (kept) => void (await this.#step(kept, { type: "release", lease, at: this.#now() })))
  }

  revoke(grant: string, by: Actor): Promise<void> {
    return this.#change(async (kept) => void (await this.#step(kept, { type: "revoke", grant, by, at: this.#now() })))
  }

  /** Every lease of a Thread here ends, its waiting asks with it, and the grants that end with it. */
  threadEnded(thread: string): Promise<void> {
    return this.#change(async (kept) => void (await this.#step(kept, { type: "thread-ended", account: this.account, thread, at: this.#now() })))
  }

  /**
   * What this device can serve and its room, as it advertises them (`Advertiser`): a need here under a grant over
   * capable devices routes to it by the same rule as the account's broker. Said only when it changed, it costs a write.
   */
  advertise(capabilities: Capability[], slots: Slots): Promise<void> {
    return this.#change(async (kept) => {
      const known = kept.state.devices[this.device]
      if (known?.online && JSON.stringify([known.capabilities, known.slots]) === JSON.stringify([capabilities, slots])) return
      await this.#step(kept, { type: "advertise", device: this.device, capabilities, slots, at: this.#now() })
    })
  }

  /** Ends leases and grants whose time has come, and answers asks waiting for a source this broker has. */
  tick(): Promise<void> {
    return this.#change(async (kept) => void (await this.#step(kept, { type: "tick", at: this.#now() })))
  }

  /** The person's answer to an ask that waited on them. */
  answer(ask: string, answer: SourceAnswer): Promise<BorrowAnswer | undefined> {
    return this.#change(async (kept) => {
      const before = kept.waiting.length
      kept.waiting = kept.waiting.filter((waiting) => waiting.ask.ask !== ask)
      if (kept.waiting.length === before) return undefined
      return (await this.#step(kept, { type: "source-answer", ask, answer, at: this.#now() })).answer
    })
  }

  /** The asks waiting on the person here, oldest first. */
  async asks(): Promise<PersonAsk[]> {
    return (await this.#read()).waiting.sort((left, right) => left.at - right.at)
  }

  async leases(filter: { borrower?: Partial<Borrower>; grant?: string } = {}): Promise<Lease[]> {
    return liveLeases((await this.#read()).state, filter)
  }

  async grants(): Promise<Grant[]> {
    return standingGrants((await this.#read()).state, this.#now())
  }

  async lease(id: string): Promise<{ lease: Lease; ended?: LeaseEnd } | undefined> {
    const held = (await this.#read()).state.leases[id]
    if (!held) return undefined
    return held.ended ? { lease: held.lease, ended: held.ended.why } : { lease: held.lease }
  }

  async *events(since = 0): AsyncIterable<LeaseEvent> {
    const folder = this.folder
    const lines = folder ? (await readFile(join(folder, "events.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => LeaseEventSchema.parse(JSON.parse(line))) : this.#log
    for (const event of lines) if (event.at >= since) yield event
  }

  /**
   * Runs `work` holding the folder's lock, for an adapter keeping a file of its own beside the state (what it placed):
   * read, changed and written back with no other broker between.
   */
  locked<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(() => this.#withLock(work))
    this.#queue = next.catch(() => undefined)
    return next
  }

  /**
   * Runs `work` holding the folder's lock while `lease` stands, and says how it ended if it doesn't. Nothing `work`
   * does can fall after the lease's revoke: a revoke takes the same lock, so it comes wholly before `work` or sees
   * everything `work` did.
   */
  whileLeased<T>(lease: string, work: () => Promise<T>): Promise<{ done: T } | { ended: LeaseEnd }> {
    return this.locked(async () => {
      const held = (await this.#load()).state.leases[lease]
      if (!held) return { ended: "released" as const }
      return held.ended ? { ended: held.ended.why } : { done: await work() }
    })
  }

  #now(): number {
    return (this.#options.now ?? Date.now)()
  }

  async #withLock<T>(work: () => Promise<T>): Promise<T> {
    const folder = this.folder
    if (!folder) return work()
    await mkdir(folder, { recursive: true, mode: 0o700 })
    const until = Date.now() + LOCK_WAIT_MS
    for (;;) {
      const lock = await acquireHostLock(folder, { purpose: "borrowing", waitMs: 0 })
      if (lock.kind === "held")
        try {
          return await work()
        } finally {
          await lock.release()
        }
      if (Date.now() >= until) throw new BorrowingLockTimeout(folder)
      await new Promise((done) => setTimeout(done, 5))
    }
  }

  async #load(): Promise<Kept> {
    const folder = this.folder
    if (!folder) return this.#memory
    const text = await readFile(join(folder, "state.json"), "utf8").catch(() => undefined)
    if (!text) return { state: emptyBroker(this.account), waiting: [], unanswered: [] }
    // SAFETY: only #save writes this file, whole and by rename, under the folder's lock, from the state `step` returned.
    const saved = JSON.parse(text) as Partial<Kept> & { state: BrokerState }
    if (saved.state.account !== this.account) return { state: emptyBroker(this.account), waiting: [], unanswered: [] }
    return { state: saved.state, waiting: saved.waiting ?? [], unanswered: saved.unanswered ?? [] }
  }

  #read(): Promise<Kept> {
    return this.locked(() => this.#load())
  }

  /** One change: under the lock, the state as it is on disk, the change, asks waiting for this broker's sources, and the state written back. */
  #change<T>(work: (kept: Kept) => Promise<T>): Promise<T> {
    const pushes: Array<[Borrower, BorrowPush]> = []
    const done = this.locked(async () => {
      const kept = await this.#load()
      const events: LeaseEvent[] = []
      this.#effects = { events, pushes }
      try {
        const value = await work(kept)
        await this.#answerWaiting(kept)
        await this.#save(kept, events)
        return value
      } finally {
        this.#effects = undefined
      }
    })
    return done.then((value) => {
      for (const [borrower, push] of pushes) for (const listener of this.#listeners) listener(borrower, push)
      return value
    })
  }

  #effects: { events: LeaseEvent[]; pushes: Array<[Borrower, BorrowPush]> } | undefined

  async #step(kept: Kept, input: BrokerInput) {
    if (input.type === "borrow" && !kept.state.devices[this.device]?.online) kept.state = step(kept.state, { type: "device", device: this.device, online: true, at: input.at }).state
    const result = step(kept.state, input)
    kept.state = result.state
    const asks: SourceAsk[] = []
    this.#collect(result.effects, asks)
    for (const ask of asks) {
      if (ask.askPerson) kept.waiting.push({ ask, at: input.at })
      else if (!this.#options.sources[ask.resource.kind]) kept.unanswered.push(ask)
      else {
        const answered = await this.#answer(kept, ask)
        if (input.type === "borrow" && answered) result.answer = answered
      }
    }
    return result
  }

  async #answer(kept: Kept, ask: SourceAsk): Promise<BorrowAnswer | undefined> {
    const source = this.#options.sources[ask.resource.kind]
    if (!source) return undefined
    const answer = await source(ask).catch((): SourceAnswer => ({ answer: "unavailable", reason: "error" }))
    const answered = step(kept.state, { type: "source-answer", ask: ask.ask, answer, at: this.#now() })
    kept.state = answered.state
    this.#collect(answered.effects, [])
    return answered.answer
  }

  /** Asks another broker over this folder couldn't answer, for a kind this one serves. */
  async #answerWaiting(kept: Kept): Promise<void> {
    const mine = kept.unanswered.filter((ask) => this.#options.sources[ask.resource.kind])
    if (!mine.length) return
    kept.unanswered = kept.unanswered.filter((ask) => !this.#options.sources[ask.resource.kind])
    for (const ask of mine) if (kept.state.asks[ask.ask]) await this.#answer(kept, ask)
  }

  #collect(effects: ReturnType<typeof step>["effects"], asks: SourceAsk[]): void {
    const into = this.#effects
    for (const effect of effects) {
      if (effect.effect === "log") into?.events.push(effect.event)
      else if (effect.effect === "push") into?.pushes.push([effect.borrower, effect.push])
      else if (effect.effect === "ask" && effect.device === this.device) asks.push(effect.ask)
    }
  }

  /** The log first, then the state, so a crash between leaves a line too many, never a decision unlogged. */
  async #save(kept: Kept, events: readonly LeaseEvent[]): Promise<void> {
    kept.waiting = kept.waiting.filter((waiting) => kept.state.asks[waiting.ask.ask])
    kept.unanswered = kept.unanswered.filter((ask) => kept.state.asks[ask.ask])
    const folder = this.folder
    if (!folder) {
      this.#memory = kept
      this.#log.push(...events)
      return
    }
    if (events.length) await appendFile(join(folder, "events.jsonl"), events.map((event) => `${JSON.stringify(event)}\n`).join(""), { mode: 0o600 })
    const temporary = join(folder, `.state.${process.pid}.${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(kept), { mode: 0o600 })
    await rename(temporary, join(folder, "state.json"))
  }
}
