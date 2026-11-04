import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
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
  type Grant,
  type Lease,
  type LeaseEvent,
  type Need,
  type SourceAnswer,
  type SourceAsk,
} from "@mako/protocol/borrow"

/**
 * This device's own broker: the borrowing contract for borrowers on this device, such as a worktree taking files
 * from its project's main checkout. It decides by the protocol's one `step`, as the account's broker does, keeps its
 * state in one file and its lease log as lines of JSON beside it (names and versions, never a value), and answers as
 * the source for what lives here. An ask that needs the person waits in `asks()` until they answer it.
 *
 * Without a folder it keeps everything in memory: the same decisions, for a host that keeps nothing on disk.
 */
export interface LocalBorrowingOptions {
  /** Where its state and log live; none keeps them in memory. */
  folder?: string
  /** This device's ID, as grants name it as their source. */
  device: string
  /** The account its grants are within; a device that isn't signed in has its own. */
  account: string
  /** What this device says, as a source, of a resource it was asked for: its version and size, or why not. */
  source: (ask: SourceAsk) => Promise<SourceAnswer>
  now?: () => number
}

export type PersonAsk = { ask: SourceAsk; at: number }

export class LocalBorrowing implements Borrowing {
  readonly device: string
  readonly account: string
  #state: BrokerState
  #loaded: Promise<void> | undefined
  #queue: Promise<unknown> = Promise.resolve()
  #log: LeaseEvent[] = []
  readonly #listeners = new Set<(borrower: Borrower, push: BorrowPush) => void>()
  readonly #waiting = new Map<string, PersonAsk>()
  readonly #options: LocalBorrowingOptions

  constructor(options: LocalBorrowingOptions) {
    this.#options = options
    this.device = options.device
    this.account = options.account
    this.#state = emptyBroker(options.account)
  }

  /** Hears every push to a borrower here: a lease decided after it waited, ended, or newer at its source. */
  onPush(listener: (borrower: Borrower, push: BorrowPush) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  grant(grant: Grant): Promise<string | undefined> {
    return this.#run(async () => (await this.#step({ type: "grant", grant, at: this.#now() })).rejected)
  }

  borrow(need: Need): Promise<BorrowAnswer> {
    return this.#run(async () => {
      const result = await this.#step({ type: "borrow", need, at: this.#now(), lease: randomUUID(), ask: randomUUID() })
      if (result.rejected || !result.answer) return { refusal: { refused: "unavailable", detail: result.rejected ?? "Not decided" } }
      return result.answer
    })
  }

  renew(lease: string): Promise<BorrowAnswer> {
    return this.#run(async () => {
      const result = await this.#step({ type: "renew", lease, at: this.#now() })
      return result.answer ?? { refusal: { refused: "unavailable", detail: result.rejected ?? "Not renewed" } }
    })
  }

  release(lease: string): Promise<void> {
    return this.#run(async () => void (await this.#step({ type: "release", lease, at: this.#now() })))
  }

  revoke(grant: string, by: Actor): Promise<void> {
    return this.#run(async () => void (await this.#step({ type: "revoke", grant, by, at: this.#now() })))
  }

  /** Every lease of a Thread here ends, and the grants that end with it. */
  threadEnded(thread: string): Promise<void> {
    return this.#run(async () => void (await this.#step({ type: "thread-ended", account: this.account, thread, at: this.#now() })))
  }

  /** Ends leases and grants whose time has come. */
  tick(): Promise<void> {
    return this.#run(async () => void (await this.#step({ type: "tick", at: this.#now() })))
  }

  /** The asks waiting on the person here, oldest first. */
  asks(): PersonAsk[] {
    return [...this.#waiting.values()].sort((left, right) => left.at - right.at)
  }

  /** The person's answer to an ask that waited on them. */
  answer(ask: string, answer: SourceAnswer): Promise<BorrowAnswer | undefined> {
    return this.#run(async () => {
      if (!this.#waiting.delete(ask)) return undefined
      return (await this.#step({ type: "source-answer", ask, answer, at: this.#now() })).answer
    })
  }

  async leases(filter: { borrower?: Partial<Borrower>; grant?: string } = {}): Promise<Lease[]> {
    await this.#load()
    return liveLeases(this.#state, filter)
  }

  async grants(): Promise<Grant[]> {
    await this.#load()
    return standingGrants(this.#state, this.#now())
  }

  async lease(id: string): Promise<{ lease: Lease; ended?: "revoked" | "expired" | "released" } | undefined> {
    await this.#load()
    const held = this.#state.leases[id]
    if (!held) return undefined
    return held.ended ? { lease: held.lease, ended: held.ended.why } : { lease: held.lease }
  }

  async *events(since = 0): AsyncIterable<LeaseEvent> {
    await this.#load()
    const folder = this.#options.folder
    const lines = folder ? (await readFile(join(folder, "events.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => LeaseEventSchema.parse(JSON.parse(line))) : this.#log
    for (const event of lines) if (event.at >= since) yield event
  }

  #now(): number {
    return (this.#options.now ?? Date.now)()
  }

  #run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(() => this.#load()).then(work)
    this.#queue = next.catch(() => undefined)
    return next
  }

  #load(): Promise<void> {
    this.#loaded ??= (async () => {
      const folder = this.#options.folder
      if (!folder) return
      const text = await readFile(join(folder, "state.json"), "utf8").catch(() => undefined)
      if (!text) return
      // SAFETY: only #save writes this file, whole and by rename, from the state `step` returned.
      const saved = JSON.parse(text) as { state: BrokerState; waiting?: PersonAsk[] }
      if (saved.state.account === this.account) this.#state = saved.state
      for (const waiting of saved.waiting ?? []) if (this.#state.asks[waiting.ask.ask]) this.#waiting.set(waiting.ask.ask, waiting)
    })()
    return this.#loaded
  }

  /** One step, its log written before its state, so a crash between leaves a line too many, never a decision unlogged. */
  async #step(input: BrokerInput) {
    if (input.type === "borrow" && !this.#state.devices[this.device]?.online) this.#state = step(this.#state, { type: "device", device: this.device, online: true, at: input.at }).state
    const result = step(this.#state, input)
    this.#state = result.state
    const events: LeaseEvent[] = []
    const pushes: Array<[Borrower, BorrowPush]> = []
    const asks: SourceAsk[] = []
    for (const effect of result.effects) {
      if (effect.effect === "log") events.push(effect.event)
      else if (effect.effect === "push") pushes.push([effect.borrower, effect.push])
      else if (effect.effect === "ask" && effect.device === this.device) asks.push(effect.ask)
    }
    for (const ask of asks) {
      if (ask.askPerson) {
        this.#waiting.set(ask.ask, { ask, at: input.at })
        continue
      }
      const answered = step(this.#state, { type: "source-answer", ask: ask.ask, answer: await this.#options.source(ask), at: this.#now() })
      this.#state = answered.state
      for (const effect of answered.effects) {
        if (effect.effect === "log") events.push(effect.event)
        else if (effect.effect === "push") pushes.push([effect.borrower, effect.push])
      }
      if (input.type === "borrow" && answered.answer) result.answer = answered.answer
    }
    await this.#save(events)
    for (const [borrower, push] of pushes) for (const listener of this.#listeners) listener(borrower, push)
    return result
  }

  async #save(events: readonly LeaseEvent[]): Promise<void> {
    const folder = this.#options.folder
    if (!folder) {
      this.#log.push(...events)
      return
    }
    await mkdir(folder, { recursive: true, mode: 0o700 })
    if (events.length) await appendFile(join(folder, "events.jsonl"), events.map((event) => `${JSON.stringify(event)}\n`).join(""), { mode: 0o600 })
    const path = join(folder, "state.json")
    const temporary = join(dirname(path), `.state.${process.pid}.${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify({ state: this.#state, waiting: [...this.#waiting.values()] }), { mode: 0o600 })
    await rename(temporary, path)
  }
}
