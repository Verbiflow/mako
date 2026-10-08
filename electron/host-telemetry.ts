import type { HarnessUpdates } from "./contracts/harness-updates.js"
import type { LiveSnapshot } from "./contracts/live-conversations.js"
import type { DiagnosticEvents, ProductEvents, TelemetryFeature } from "./contracts/telemetry.js"
import type { CrashReport } from "./crash.js"
import type { UnknownKind } from "./native-unknown.js"
import type { Telemetry } from "./telemetry.js"
import { errorReported, harnessId, harnessInventory, turnChanges, turnCompleted, turnStarted, unknownSince } from "./telemetry-events.js"

/**
 * The host's telemetry: turns as they start and end, Threads, features, a
 * daily heartbeat, and every process's crash reports. The host is the one
 * process all windows share, so each event is counted once.
 *
 * Crash reports and unknown native records are swept every `SWEEP_MS` rather
 * than hooked: the desktop clients write theirs into the shared crash folder,
 * and a sweep reads only the files past the last one reported.
 */
const SWEEP_MS = 5 * 60_000
const FIRST_SWEEP_MS = 60_000
const MAX_CRASHES_PER_SWEEP = 10
const MAX_TRACKED_TURNS = 1_000

export interface HostTelemetrySources {
  crashesAfter(id: string): CrashReport[]
  crashIdAt(at: number): string
  unknownKinds(): UnknownKind[]
  /** The signed-in Mako account's ID, or undefined while signed out. */
  account(): Promise<string | undefined>
  /** A window is open on this host. The heartbeat counts days someone used Mako, not days a host ran. */
  attended(): boolean
  inventory(): Promise<{ harnesses: string[]; runtimes: HarnessUpdates; threads: number }>
  now?: () => number
}

export class HostTelemetry {
  readonly telemetry: Telemetry
  #sources: HostTelemetrySources
  /** When each request in flight was dispatched, for its turn's duration. */
  #dispatched = new Map<string, number>()
  #unknownReported = new Map<string, number>()
  #timers: NodeJS.Timeout[] = []

  constructor(telemetry: Telemetry, sources: HostTelemetrySources) {
    this.telemetry = telemetry
    this.#sources = sources
  }

  /** The host is up: `app.started` now, the first sweep in a minute, then every five. */
  async started(startupMs: number | undefined): Promise<void> {
    if (this.telemetry.crashesThrough() === undefined) await this.telemetry.reportedCrashesThrough(this.#sources.crashIdAt(this.#now()))
    if (this.telemetry.collects("usage")) {
      const account = await this.#account()
      this.telemetry.record("app.started", {
        ...(startupMs !== undefined && { startupMs: Math.min(Math.round(startupMs), 600_000) }),
        firstRun: this.telemetry.firstRun,
        signedIn: account !== undefined,
      })
      if (account) await this.telemetry.linkAccount(account)
    }
    const sweep = () => void this.sweep().catch(() => undefined)
    const first = setTimeout(sweep, FIRST_SWEEP_MS)
    const every = setInterval(sweep, SWEEP_MS)
    first.unref?.()
    every.unref?.()
    this.#timers.push(first, every)
  }

  /** `Dependencies.turns`: runs on every journal commit that changed requests, so it only diffs and pushes. */
  readonly turns = (previous: LiveSnapshot, next: LiveSnapshot): void => {
    try {
      if (!this.telemetry.collects("usage")) {
        this.#dispatched.clear()
        return
      }
      const { started, settled } = turnChanges(previous, next)
      const now = this.#now()
      for (const request of started) {
        const props = turnStarted(next.session, request)
        if (props) this.telemetry.record("turn.started", props)
        this.#dispatched.set(request.id, now)
        if (this.#dispatched.size > MAX_TRACKED_TURNS) this.#dispatched.delete(this.#dispatched.keys().next().value!)
      }
      for (const request of settled) {
        const at = this.#dispatched.get(request.id)
        this.#dispatched.delete(request.id)
        const props = turnCompleted(next, request, at === undefined ? undefined : now - at)
        if (props) this.telemetry.record("turn.completed", props)
      }
    } catch {
      // Telemetry never costs a conversation its commit.
    }
  }

  threadCreated(props: ProductEvents["thread.created"]): void {
    if (harnessId(props.harness)) this.telemetry.record("thread.created", props)
  }

  feature(feature: TelemetryFeature, harness?: string): void {
    const id = harness && harnessId(harness)
    this.telemetry.record("feature.used", id ? { feature, harness: id } : { feature })
  }

  /** This Mac just signed in to Mako: the feature, and its history linked to the account. */
  async signedIn(): Promise<void> {
    this.feature("cloud.signed-in")
    const account = await this.#account()
    if (account) await this.telemetry.linkAccount(account)
  }

  /** A call to the Mako cloud ended. Its correlation ID finds the cloud's side of it. */
  cloudRequest(call: DiagnosticEvents["cloud.request"]): void {
    this.telemetry.report("cloud.request", call)
  }

  /** Crash reports and unknown native records since the last sweep, and the heartbeat when it is due. */
  async sweep(): Promise<void> {
    if (this.telemetry.state().off) return
    await this.#crashes()
    const unknown = unknownSince(this.#sources.unknownKinds(), this.#unknownReported)
    if (this.telemetry.collects("errors")) for (const props of unknown) this.telemetry.report("native.unknown", props)
    if (this.#sources.attended() && (await this.telemetry.heartbeatDue())) {
      const [inventory, account] = await Promise.all([this.#sources.inventory(), this.#account()])
      this.telemetry.record("app.heartbeat", {
        harnesses: harnessInventory(inventory.harnesses, inventory.runtimes),
        threads: Math.min(inventory.threads, 1e7),
        signedIn: account !== undefined,
      })
      if (account) await this.telemetry.linkAccount(account)
    }
  }

  async close(): Promise<void> {
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers = []
    await this.telemetry.close()
  }

  /** What's past the mark `started` set, so an install reports nothing from before it. */
  async #crashes(): Promise<void> {
    const through = this.telemetry.crashesThrough()
    if (through === undefined) return
    const fresh = this.#sources.crashesAfter(through)
    const newest = fresh.at(-1)
    if (!newest) return
    if (this.telemetry.collects("errors"))
      for (const crash of fresh.slice(-MAX_CRASHES_PER_SWEEP)) this.telemetry.report("error.reported", errorReported(crash))
    await this.telemetry.reportedCrashesThrough(newest.id)
  }

  #account(): Promise<string | undefined> {
    return this.#sources.account().catch(() => undefined)
  }

  #now(): number {
    return this.#sources.now?.() ?? Date.now()
  }
}
