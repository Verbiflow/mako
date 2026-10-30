import type { RecoveryLink } from "./host-call-recovery.js"

/** What a window hears of its host's connection: the reconnect banner, raised or cleared. */
export type HostConnectionEvent = { type: "host-disconnected"; message: string } | { type: "host-reconnected" }

/**
 * A cheap question to the host the window's stream is attached to. `alive`: that host answered. `absent`: nothing
 * answers there, or another host does. `unknown`: no answer in time, or no way to ask (a page, whose dev proxy
 * forwards only calls and the stream).
 */
export type HostProbe = "alive" | "absent" | "unknown"

/** Two of the host's heartbeats (`keep event streams alive`, every 15 seconds), and slack for a held event loop. */
export const HOST_PROOF_MS = 35_000

export interface HostLivenessOptions {
  /** Raises or clears the window's reconnect banner. */
  announce(event: HostConnectionEvent): void
  probe(timeoutMs: number): Promise<HostProbe>
  /** The banner's wording. */
  message: string
  /** How long a dropped call waits for the host to show itself before the window hears of an outage. */
  proofMs?: number
}

/** One event stream's say. A stream a newer one replaced says nothing more. */
export interface HostStream {
  /** Its `ready` line: attached to a host. */
  ready(): void
  /** Any bytes on it, the heartbeat included. */
  heard(): void
  /** It ended: the host left, or the connection to it did. */
  ended(): void
}

interface Check {
  result: Promise<boolean>
  finish(alive: boolean): void
}

/**
 * One window's connection to its host, as the window shows it. The event stream is the proof of the host's
 * liveness: it stays open while the host runs, carries a heartbeat every 15 seconds, and ends when the host or its
 * socket goes. So the reconnect banner goes up when the stream ends and comes down when a stream says `ready`, or
 * when the same stream is heard from again.
 *
 * A dropped call proves nothing by itself: a call can fail while the host is alive and streaming. While the stream is
 * open, a drop asks the host (`probe`) and listens to the stream; either answering shows the host is there, and the
 * call may run again at once. The window hears of an outage only when the probe finds no host there or nothing is
 * heard for `proofMs`; once anything is heard again, the banner clears itself.
 */
export class HostLiveness implements RecoveryLink {
  private live = false
  private announced = false
  private seen = false
  private disposed = false
  private generation = 0
  /** The generation of the stream that said `ready` and hasn't ended, or null. */
  private open: number | null = null
  private check: Check | undefined
  private readonly waiters = new Set<(connected: boolean) => void>()
  private readonly options: HostLivenessOptions

  constructor(options: HostLivenessOptions) {
    this.options = options
  }

  /** Whether the host is taken as there: a call may go to it, and one waiting for it goes now. */
  get connected(): boolean {
    return this.live
  }

  /** A new event stream, its say bound to it alone. */
  stream(): HostStream {
    const generation = ++this.generation
    this.open = null
    const current = () => !this.disposed && this.generation === generation
    return {
      ready: () => {
        if (!current()) return
        this.open = generation
        // Every attach after the first may be a new host, which the window boots again from; and an outage
        // announced before the first attach is cleared by it.
        const announce = this.seen || this.announced
        this.seen = true
        this.check?.finish(true)
        this.up(announce)
      },
      heard: () => {
        if (!current() || this.open !== generation) return
        this.check?.finish(true)
        // The host said nothing for a while, or a probe missed it, and now it speaks on the same stream.
        if (!this.live) this.up(this.announced)
      },
      ended: () => {
        if (!current()) return
        this.open = null
        this.down()
        this.check?.finish(false)
      },
    }
  }

  async dropped(timeoutMs: number): Promise<boolean> {
    if (this.disposed) return false
    // An outage the window already knows of: wait for the stream to attach again.
    if (!this.live) return this.whenConnected(timeoutMs)
    const started = Date.now()
    const verdict = await within(this.verify(), timeoutMs)
    // Still not heard from: give this call up, and let the check decide about the outage on its own.
    if (verdict === undefined) return false
    if (verdict) return true
    return this.whenConnected(Math.max(0, timeoutMs - (Date.now() - started)))
  }

  /** Resolves true once the host is taken as there, false at the deadline or once the window has closed. */
  whenConnected(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.live) { resolve(true); return }
      if (this.disposed) { resolve(false); return }
      const waiter = (connected: boolean) => { clearTimeout(deadline); resolve(connected) }
      const deadline = setTimeout(() => { this.waiters.delete(waiter); resolve(false) }, timeoutMs)
      this.waiters.add(waiter)
    })
  }

  dispose(): void {
    this.disposed = true
    this.live = false
    this.check?.finish(false)
    this.settle(false)
  }

  /** One check at a time, whichever call dropped first; true once the host is shown to be there. */
  private verify(): Promise<boolean> {
    if (this.check) return this.check.result
    let settle: (alive: boolean) => void = () => {}
    const result = new Promise<boolean>((resolve) => { settle = resolve })
    let done = false
    const check: Check = {
      result,
      finish: (alive) => {
        if (done) return
        done = true
        clearTimeout(deadline)
        if (this.check === check) this.check = undefined
        // No host where the stream's was, or nothing heard in time: the window hears of the outage now.
        if (!alive) this.down()
        settle(alive)
      },
    }
    this.check = check
    const proofMs = this.options.proofMs ?? HOST_PROOF_MS
    // Set before anything can finish the check: the probe answers later, and the stream speaks on another turn.
    const deadline = setTimeout(() => check.finish(false), proofMs)
    void this.options.probe(proofMs).then((answer) => {
      if (answer === "alive") check.finish(true)
      else if (answer === "absent") check.finish(false)
      // Unknown: the stream still has until the deadline to be heard.
    }, () => {})
    return result
  }

  private up(announce: boolean): void {
    this.live = true
    this.announced = false
    this.settle(true)
    if (announce) this.options.announce({ type: "host-reconnected" })
  }

  /** Once per outage, whichever notices it first. */
  private down(): void {
    this.live = false
    if (this.announced || this.disposed) return
    this.announced = true
    this.options.announce({ type: "host-disconnected", message: this.options.message })
  }

  private settle(connected: boolean): void {
    for (const waiter of this.waiters) waiter(connected)
    this.waiters.clear()
  }
}

/** `promise`'s value, or undefined if it hasn't settled within `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    void promise.then((value) => { clearTimeout(timer); resolve(value) })
  })
}
