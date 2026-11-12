import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { decodeReply, encodeOperation } from "@mako/protocol"
import { BorrowAnswerSchema, type BorrowAnswer, type Lease, type Need } from "@mako/protocol/borrow"
import { z } from "zod"
import { borrowWords, type WordedDevice } from "@mako/protocol/borrow-words"
import { hostCallInput, hostReplyValue, toHostOperation } from "../../contracts/host-operations.js"
import { decodeRuntimeValue } from "../../contracts/runtime-value.js"
import {
  CLAIM_IDLE_MS,
  macHostId,
  type ListedSimulator,
  type SimulatorArtifact,
  type SimulatorCaller,
  type SimulatorHostSummary,
  type SimulatorRefused,
  type SimulatorsActInput,
  type SimulatorsActResult,
  type SimulatorsOpenInput,
  type SimulatorsOpenResult,
  type SimulatorsReadInput,
  type SimulatorsReadResult,
  type SimulatorsRecordInput,
  type SimulatorsRecordResult,
  type SimulatorsReleaseInput,
  type SimulatorsReleaseResult,
  type SimulatorsShotInput,
  type SimulatorsShotResult,
  type SimulatorsWatchInput,
  type SimulatorsWatchResult,
} from "../../contracts/simulators.js"
import { HeldLeases } from "../../base/held-leases.js"
import { hostLog, hostWarn } from "../../base/host-log.js"
import { hostStopping, untilStopped } from "../../base/host-stopping.js"
import type { RemoteSimulatorHost } from "./host.js"
import { RemoteMacSimulators, type SimulatorHostCall } from "./remote-host.js"

/** What borrowing a simulator needs of the place this host runs at: its Thread's routes to the account's broker. */
export interface SimulatorBorrowing {
  need(need: Omit<Need, "for">): Promise<BorrowAnswer>
  /** A final shutdown release may use its own bounded cleanup signal after the host stopped. */
  release(lease: string, cleanup?: AbortSignal): Promise<void>
  /** The lease again for its next stretch, or why it can't be. */
  renew(lease: string): Promise<BorrowAnswer>
  /** A host operation, as wire text, to the device serving the lease; its reply as wire text. Throws `LeaseEnded` once it ended. */
  call(lease: string, operation: string): Promise<string>
  /** A file the session made, from the lease's artifacts, by its hash. */
  artifact(lease: string, hash: string): Promise<Uint8Array>
  /** The person's devices that can serve `ref`, as the broker last heard them, for a wait's words. */
  devices(ref: string): Promise<WordedDevice[]>
}

/** Where a cloud Thread's machine reaches the account's broker, and as whom: its machine's link. */
export type BorrowingLink = { gatewayUrl: string; machine: string; credential: string }

const WordedDevicesSchema = z.object({ devices: z.array(z.object({ id: z.string(), name: z.string(), online: z.boolean(), lastSeen: z.number().nullable() }).strip()) })

/**
 * A cloud Thread's machine's routes to the account's broker, as its credential names it, for borrowing a simulator.
 * Every answer but a success is a failure, a release's included (`410` is the lease already gone: ended, not failed).
 */
export function accountBorrowing(link: () => BorrowingLink | null, fetching: typeof fetch = fetch, owner: AbortSignal | undefined = hostStopping()?.signal): SimulatorBorrowing {
  const request = async <Result>(method: string, path: string, read: (response: Response) => Promise<Result>, body?: string, cleanup?: AbortSignal): Promise<Result> => {
    // Normal work belongs to this host (or its admitted call). Shutdown's final DELETE has a separate, bounded owner.
    const lifetime = cleanup ?? owner ?? hostStopping()?.signal
    const controller = new AbortController()
    const deadline = AbortSignal.timeout(75_000)
    const signal = AbortSignal.any([controller.signal, deadline, ...(lifetime ? [lifetime] : [])])
    signal.throwIfAborted()
    const linked = link()
    if (!linked) throw new Error("This machine isn't linked to Mako's cloud yet.")
    const url = new URL(`/v1/machines/${encodeURIComponent(linked.machine)}/borrow${path}`, linked.gatewayUrl)
    try {
      const response = await untilStopped(fetching(url, { method, headers: { authorization: `Bearer ${linked.credential}`, ...(body !== undefined && { "content-type": "application/json" }) }, ...(body !== undefined && { body }), signal }), signal)
      // Keep the same owner through json/text/binary reads and error bodies, not just the response headers.
      return await untilStopped(read(response), signal)
    } finally {
      // End any unread/error body too; no request remains owned only by its independent deadline.
      controller.abort()
    }
  }
  const ok = async (response: Response): Promise<Response> => {
    if (response.status === 410) throw new LeaseEnded(await response.text())
    if (!response.ok) throw new Error(`Mako's cloud answered ${response.status}`)
    return response
  }
  return {
    need: (need) => request("POST", "/needs", async (response) => BorrowAnswerSchema.parse(await (await ok(response)).json()), JSON.stringify(need)),
    release: (lease, cleanup) => request("DELETE", `/leases/${encodeURIComponent(lease)}`, async (response) => {
      if (response.status !== 410) await ok(response)
    }, undefined, cleanup),
    renew: (lease) => request("POST", `/leases/${encodeURIComponent(lease)}/renew`, async (response) => BorrowAnswerSchema.parse(await (await ok(response)).json())),
    call: (lease, operation) => request("POST", `/leases/${encodeURIComponent(lease)}/call`, async (response) => (await ok(response)).text(), operation),
    artifact: (lease, hash) => request("GET", `/leases/${encodeURIComponent(lease)}/artifacts/${encodeURIComponent(hash)}`, async (response) => new Uint8Array(await (await ok(response)).arrayBuffer())),
    devices: (ref) => request("GET", `/devices?ref=${encodeURIComponent(ref)}`, async (response) => WordedDevicesSchema.parse(await (await ok(response)).json()).devices),
  }
}

/** The lease a call was under ended (released, revoked, lost): borrow again. */
export class LeaseEnded extends Error {
  constructor(why: string) {
    super(why)
    this.name = "LeaseEnded"
  }
}

const REF = "ios-simulator"
/** How often a held simulator is read while its lease lives, inside its claim's idle window, so a watch-only session keeps it. */
export const KEEP_ALIVE_MS = CLAIM_IDLE_MS / 3
/** A lease this close to its end is renewed at the next keep-alive. */
const RENEW_BEFORE_MS = 2 * KEEP_ALIVE_MS
/** How long closing waits for the account to confirm its releases: a host stopping never hangs on the network. */
const CLOSE_RELEASE_MS = 5_000

/**
 * A cloud Thread's simulators: one of the person's Macs, borrowed as a session lease and driven over the lease's calls.
 * The first look borrows one (`ensure`), and an answer that isn't a lease reads in words with its reason and deadline.
 * Once leased, the Mac is a host like any other Mac (`mac:<device>`), its every refusal mapped to one outcome in words
 * (design 7.8): asleep waits, a lapsed claim re-opens once, a vanished simulator is re-listed once, the person's no is
 * final, and an act whose outcome is unknown is never sent again. While a simulator is held it's read within each idle
 * window, so a long session that only watches keeps its claim. Each lease's end frees it here; the next look borrows.
 * Its lease is held under borrowing's lifecycle rules (`HeldLeases`): an answer, a renewal or a list that comes after a
 * release, an end or another lease holds nothing (a late lease is released), a release is kept until the account
 * confirms it, and closing releases everything this host borrowed.
 */
export class BorrowedSimulators {
  readonly #port: SimulatorBorrowing
  readonly #shots: string
  readonly #now: () => number
  #correlation = randomUUID()
  readonly #held = new HeldLeases()
  /** The lease its Thread uses now, held in `#held`. */
  #lease: Lease | undefined
  #host: LeasedMac | undefined
  #words: string | undefined
  #closed = false
  #closing: Promise<void> | undefined

  constructor(options: { port: SimulatorBorrowing; shots: string; now?: () => number }) {
    this.#port = options.port
    this.#shots = options.shots
    this.#now = options.now ?? Date.now
  }

  /** The borrowed Mac, as a host its Thread's calls go to; none before a lease. */
  remotes(): RemoteSimulatorHost[] {
    return this.#host ? [this.#host] : []
  }

  /**
   * Borrows a simulator for this Thread, or reads how its wait stands: the same need, by its correlation ID, until a
   * lease comes and while it lives. Undefined once leased; else the words of the wait or its end, as a host the list
   * shows so the agent reads them where it looks.
   */
  async ensure(why: string): Promise<SimulatorHostSummary | undefined> {
    if (this.#closed) return undefined
    if (this.#host && this.#lease && this.#lease.expiresAt > this.#now()) return undefined
    const since = this.#held.begin()
    const answer = await this.#port.need({ kind: "operation", ref: REF, why, correlationId: this.#correlation })
    if ("lease" in answer && answer.lease.device) {
      const devices = await this.#devices()
      const taken = this.#held.take(answer.lease, this.#now(), since)
      if (taken === "held" || (taken !== "stale" && !this.#host)) this.#take(answer.lease, devices)
      else if (taken === "stale" && !this.#held.has(answer.lease.id) && !this.#held.ended(answer.lease.id)) await this.#releaseLate(answer.lease.id)
      return undefined
    }
    // A wait that ended, however it ended, makes the next ask a new need.
    if ("refusal" in answer) this.#correlation = randomUUID()
    this.#words = borrowWords(answer, REF, await this.#devices(), this.#now())
    hostLog("simulators", "borrowing", { outcome: "lease" in answer ? "lease" : "pending" in answer ? `pending:${answer.pending}` : `refused:${answer.refusal.refused}` })
    const waiting = { ready: false as const, blocker: "unreachable" as const, why: this.#words }
    return { id: "borrowing", label: "Your Mac", kind: "mac", platforms: { ios: waiting, android: { ready: false, blocker: "not-built", why: "Android emulators come after iOS." } } }
  }

  /**
   * The Thread is done with its simulator: the claim and the lease go, and its Mac's slot is free. Anything still being
   * acquired holds nothing when it comes. The release is kept until the account confirms it, tried again by the next
   * release or keep-alive, or the host's first close, and a failure is thrown, so it's said.
   */
  async release(cleanup?: AbortSignal): Promise<void> {
    this.#held.invalidate()
    const lease = this.#lease
    this.#drop("released")
    if (lease) this.#held.releasing(lease.id)
    await this.#releasePending(cleanup)
  }

  /** The releases the account hasn't confirmed yet, by lease. */
  unreleased(): string[] {
    return this.#held.unreleased()
  }

  /**
   * This host stops: everything it borrowed is released, the lease a list took included, and one still being acquired
   * is released when it comes. It waits for the account at most `CLOSE_RELEASE_MS`; a release it didn't hear confirmed
   * is cancelled and logged as unconfirmed, and the broker ends that lease at its expiry. Repeated closes join this
   * one cleanup window.
   */
  close(): Promise<void> {
    if (this.#closing) return this.#closing
    this.#closed = true
    const cleanup = new AbortController()
    const timer = setTimeout(() => cleanup.abort(new Error("The borrowed lease release grace ended")), CLOSE_RELEASE_MS).unref()
    this.#closing = this.release(cleanup.signal)
      .catch((error: Error) => hostWarn("simulators", "a borrowed lease's release on close failed", { error: error.message, leases: this.unreleased().join(",") }))
      .finally(() => {
        clearTimeout(timer)
        cleanup.abort()
      })
    return this.#closing
  }

  /**
   * Reads the held simulator once, so its claim stays while the lease lives, and renews the lease near its end; the job
   * that runs it runs every `KEEP_ALIVE_MS`. A lease that can't be renewed ends here.
   */
  async keepAlive(): Promise<void> {
    if (this.#held.unreleased().length > 0) await this.#releasePending().catch((error: Error) => hostWarn("simulators", "a borrowed lease's release failed again", { error: error.message }))
    const lease = this.#lease
    if (lease && lease.expiresAt - this.#now() < RENEW_BEFORE_MS) {
      const since = this.#held.begin()
      const renewed = await this.#port.renew(lease.id).catch(() => undefined)
      // A renewal counts only for the lease still held, as it was when the renewal was asked.
      if (renewed && "lease" in renewed) {
        if (this.#held.take(renewed.lease, this.#now(), since) === "renewed") this.#lease = this.#held.get(lease.id)
      } else if (renewed && this.#lease?.id === lease.id) this.ended(lease.id)
    }
    await this.#host?.keepAlive()
  }

  /** The lease ended, as a call found or its push said, held here yet or not: the next look borrows again. */
  ended(lease: string): void {
    this.#held.end(lease)
    this.#held.released(lease)
    if (this.#lease?.id === lease) this.#drop("ended")
  }

  #take(lease: Lease, devices: WordedDevice[]): void {
    if (this.#lease?.id === lease.id && this.#host) return
    const device = lease.device!
    const name = devices.find((each) => each.id === device)?.name ?? "Your Mac"
    this.#lease = lease
    this.#words = undefined
    const call: SimulatorHostCall = async (channel, args) => {
      const operation = toHostOperation(channel, hostCallInput(args, false), {
        id: randomUUID(),
        target: { kind: "runtime", runtimeId: `d-${device}` },
        actor: { kind: "runtime", runtimeId: "borrower" },
        correlationId: randomUUID(),
        attempt: 1,
      })
      let text: string
      try {
        text = await this.#port.call(lease.id, encodeOperation(operation))
      } catch (error) {
        if (error instanceof LeaseEnded) this.ended(lease.id)
        throw error
      }
      const value = decodeRuntimeValue(hostReplyValue(decodeReply(text)))
      // SAFETY: a simulators verb's host reply is an object (its result or its refusal), as the far host encoded it.
      return (value ?? {}) as object
    }
    const artifact = async (made: SimulatorArtifact): Promise<string> => {
      await mkdir(this.#shots, { recursive: true })
      const path = join(this.#shots, `${made.hash.slice(0, 16)}-${basename(made.name)}`)
      await writeFile(path, await this.#port.artifact(lease.id, made.hash))
      return path
    }
    this.#host = new LeasedMac(new RemoteMacSimulators({ id: macHostId(device), label: name, call, shots: this.#shots, artifact }), name, () =>
      // The Thread let go: a release the account didn't confirm stays kept, and the next keep-alive tries it again.
      void this.release().catch((error: Error) => hostWarn("simulators", "a borrowed lease's release failed", { lease: lease.id, error: error.message, leases: this.unreleased().join(",") }))
    )
    hostLog("simulators", "borrowed", { lease: lease.id, device })
  }

  #drop(why: string): void {
    if (!this.#lease) return
    hostLog("simulators", "borrowed lease let go", { lease: this.#lease.id, why })
    this.#held.end(this.#lease.id)
    this.#lease = undefined
    this.#host = undefined
    this.#correlation = randomUUID()
  }

  /** A lease that came after its borrowing was let go: released, never used. */
  async #releaseLate(lease: string): Promise<void> {
    hostLog("simulators", "a late lease is released", { lease })
    this.#held.end(lease)
    this.#held.releasing(lease)
    await this.#releasePending().catch((error: Error) => hostWarn("simulators", "a late lease's release failed", { lease, error: error.message }))
  }

  /** Every release not yet confirmed, asked of the account again; the first failure is thrown once all were tried. */
  async #releasePending(cleanup?: AbortSignal): Promise<void> {
    const failures: Error[] = []
    for (const lease of this.#held.unreleased()) {
      try {
        cleanup?.throwIfAborted()
        const released = this.#port.release(lease, cleanup)
        await (cleanup ? untilStopped(released, cleanup) : released)
        this.#held.released(lease)
      } catch (error) {
        if (error instanceof LeaseEnded) this.#held.released(lease)
        else failures.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
    if (failures[0]) throw failures[0]
  }

  async #devices(): Promise<WordedDevice[]> {
    return this.#port.devices(REF).catch(() => [])
  }
}

/** A refusal said as the outcome the agent acts on, never the far Mac's own words alone (design 7.8). */
function outcome(refused: SimulatorRefused, mac: string): SimulatorRefused {
  switch (refused.refused) {
    case "unreachable":
      return { ...refused, why: `${mac} is asleep or offline. Waiting for it: the lease holds for a few minutes, and a new one is asked for once it's gone. Waking it is the person's to do.` }
    case "not-offered":
    case "unavailable":
      return { ...refused, why: `${mac} can't lend this simulator now. Look again with simulator_list: another Mac is asked for, or the wait says why.` }
    case "held":
      return { ...refused, why: `iOS simulator: on ${mac}, held by ${refused.holder?.title ?? "another Thread"}; it starts when it's free. The person can always take it over.` }
    case "not-found":
      return { ...refused, why: "That simulator isn't on the Mac any more. simulator_list names the ones that are." }
    case "not-allowed":
      return { ...refused, why: `The person declined the simulator on ${mac}. Don't ask again unless they say so.` }
    case "no-thread":
      return { ...refused, why: `Mako couldn't name your Thread to ${mac}.` }
    default:
      return refused
  }
}

/** The far Mac as a host here: its verbs, each refusal mapped once, a lapsed claim re-opened once, an unknown act never resent. */
class LeasedMac implements RemoteSimulatorHost {
  readonly id: string
  readonly label: string
  readonly #inner: RemoteMacSimulators
  readonly #mac: string
  readonly #released: () => void
  /** The simulator this Thread opened, and how: what a lapsed claim re-opens, and what keep-alive reads. */
  #opened: { caller: SimulatorCaller; input: SimulatorsOpenInput } | undefined

  /** `released`: the Thread let go of its simulator, so its lease goes too and the Mac's slot is free. */
  constructor(inner: RemoteMacSimulators, mac: string, released: () => void) {
    this.#inner = inner
    this.id = inner.id
    this.label = inner.label
    this.#mac = mac
    this.#released = released
  }

  async list(caller: SimulatorCaller): Promise<{ hosts: SimulatorHostSummary[]; simulators: ListedSimulator[] }> {
    return this.#inner.list(caller)
  }

  async open(caller: SimulatorCaller, input: SimulatorsOpenInput): Promise<SimulatorsOpenResult> {
    let opened = await this.#inner.open(caller, input)
    if ("refused" in opened && opened.refused === "not-found") {
      // Re-listed once: the Mac may have made the simulator again under the same name.
      await this.#inner.list(caller)
      opened = await this.#inner.open(caller, input)
    }
    if ("refused" in opened) return outcome(opened, this.#mac)
    this.#opened = { caller, input: { simulator: input.simulator, host: input.host } }
    return opened
  }

  act(caller: SimulatorCaller, input: SimulatorsActInput): Promise<SimulatorsActResult> {
    return this.#held(caller, input, "act", () => this.#inner.act(caller, input), (refused) =>
      refused.refused === "unreachable"
        ? { ...refused, why: `${this.#mac} didn't answer, so whether that was done is unknown. Read the screen (simulator_shot or simulator_read) before acting again; it isn't sent twice.` }
        : outcome(refused, this.#mac)
    )
  }

  read(caller: SimulatorCaller, input: SimulatorsReadInput): Promise<SimulatorsReadResult> {
    return this.#held(caller, input, "read", () => this.#inner.read(caller, input))
  }

  record(caller: SimulatorCaller, input: SimulatorsRecordInput): Promise<SimulatorsRecordResult> {
    return this.#held(caller, input, "record", () => this.#inner.record(caller, input))
  }

  watch(caller: SimulatorCaller, input: SimulatorsWatchInput): Promise<SimulatorsWatchResult> {
    return this.#mapped(this.#inner.watch(caller, input))
  }

  shot(caller: SimulatorCaller, input: SimulatorsShotInput): Promise<SimulatorsShotResult> {
    return this.#mapped(this.#inner.shot(caller, input))
  }

  async release(caller: SimulatorCaller, input: SimulatorsReleaseInput): Promise<SimulatorsReleaseResult> {
    this.#opened = undefined
    const released = await this.#mapped(this.#inner.release(caller, input))
    this.#released()
    return released
  }

  async keepAlive(): Promise<void> {
    const opened = this.#opened
    if (opened) await this.#inner.read(opened.caller, { simulator: opened.input.simulator, host: opened.input.host, what: "page" })
  }

  /**
   * A verb on the held simulator. Refused as `stale` or `not-open`, nothing was done: the claim is re-opened once under
   * the same lease and the verb sent again once. Every other refusal is mapped as it is.
   */
  async #held<Result extends object>(caller: SimulatorCaller, input: { simulator: string; host: string }, verb: string, run: () => Promise<Result | SimulatorRefused>, map: (refused: SimulatorRefused) => SimulatorRefused = (refused) => outcome(refused, this.#mac)): Promise<Result | SimulatorRefused> {
    const first = await run()
    if (!("refused" in first) || (first.refused !== "stale" && first.refused !== "not-open")) return "refused" in first ? map(first) : first
    const again = await this.#inner.open(caller, this.#opened?.input ?? { simulator: input.simulator, host: input.host })
    if ("refused" in again) return { ...outcome(again, this.#mac), why: `This Thread's claim on the simulator lapsed and it couldn't be opened again: ${outcome(again, this.#mac).why}` }
    hostLog("simulators", "re-opened a lapsed claim", { verb })
    const second = await run()
    return "refused" in second ? map(second) : second
  }

  async #mapped<Result extends object>(result: Promise<Result | SimulatorRefused>): Promise<Result | SimulatorRefused> {
    const value = await result
    return "refused" in value ? outcome(value, this.#mac) : value
  }
}
