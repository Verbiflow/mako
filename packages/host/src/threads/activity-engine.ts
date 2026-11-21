import type {
  ProviderActivitySession,
  ProviderProcessProbe,
} from "./harnesses.js"

/** How often a harness with nothing open is looked at for one opening (`ProviderProcessProbe.idlePollMs`). */
const IDLE_POLL_MS = 30_000

export interface ProviderActivitySnapshot {
  provider: string
  sessions: ProviderActivitySession[]
}

interface ProbeSlot {
  probe: ProviderProcessProbe
  timer: NodeJS.Timeout | null
  controller: AbortController | null
  /** The probe under way, for a look that joins it. */
  reading: Promise<boolean> | null
  sessions: ProviderActivitySession[]
  lastAvailableAt: number
  failures: number
}

function sessionKey(session: ProviderActivitySession): string {
  return session.path ?? session.nativeId ?? ""
}

function normalizeSessions(
  sessions: ProviderActivitySession[]
): ProviderActivitySession[] {
  const byKey = new Map<string, ProviderActivitySession>()
  for (const session of sessions) {
    const key = sessionKey(session)
    if (!key) continue
    const current = byKey.get(key)
    if (
      !current ||
      session.status === "needs-input" ||
      (current.status === "open" && session.status === "active")
    )
      byKey.set(key, session)
  }
  return [...byKey.values()].sort((left, right) =>
    sessionKey(left).localeCompare(sessionKey(right))
  )
}

function sameSessions(
  left: ProviderActivitySession[],
  right: ProviderActivitySession[]
): boolean {
  return (
    left.length === right.length &&
    left.every((session, index) => {
      const candidate = right[index]
      return (
        candidate?.nativeId === session.nativeId &&
        candidate.path === session.path &&
        candidate.status === session.status &&
        candidate.detail === session.detail
      )
    })
  )
}

/** A look made for one asker while the engine rests answers every asker this long: as fresh as a harness seen open is kept. */
const LOOK_FRESH_MS = 5_000

/**
 * An engine that looks only while someone needs its answer. An idle Mac asked `lsof` for each harness every half
 * minute for answers nobody read, and those asks alone kept the probes' child running. While `needed` says no, the
 * engine rests with what it last read; whoever must know then asks `settled`, which looks once for them.
 */
export class NeededActivity {
  readonly #engine: ProviderActivityEngine
  readonly #needed: () => boolean
  readonly #freshMs: number
  /** The look `settled` waits for: the first as looking starts again, or its own. */
  #look: Promise<void> | undefined
  #lookedAt = Number.NEGATIVE_INFINITY

  constructor(engine: ProviderActivityEngine, needed: () => boolean, freshMs = LOOK_FRESH_MS) {
    this.#engine = engine
    this.#needed = needed
    this.#freshMs = freshMs
  }

  /** Starts or rests the engine as `needed` now says; called whenever what it reads may have changed. */
  follow(): void {
    const needed = this.#needed()
    if (!needed && this.#engine.running) this.#engine.pause()
    if (!needed || this.#engine.running) return
    this.#looking()
    this.#engine.start()
  }

  /** Whether the engine rests: nobody needs its answer, and nobody hears what it would find. */
  get resting(): boolean { return !this.#engine.running }

  /**
   * Done once what the engine holds is as a running engine would have it: at once while it runs and has looked, after
   * its first look when it has just started again, and after a look made for this ask when it rests. Whether it waited.
   */
  async settled(): Promise<boolean> {
    if (!this.#engine.running && !this.#look && performance.now() - this.#lookedAt > this.#freshMs) this.#looking()
    const look = this.#look
    if (!look) return false
    await look
    return true
  }

  #looking(): void {
    const look = this.#engine.look().then(() => {
      this.#lookedAt = performance.now()
      if (this.#look === look) this.#look = undefined
    })
    this.#look = look
  }
}

export class ProviderActivityEngine {
  readonly #slots = new Map<string, ProbeSlot>()
  readonly #listeners = new Set<(snapshot: ProviderActivitySnapshot) => void>()
  #running = false
  #looking: Promise<void> | undefined
  /** Moves at each `stop`: a probe begun before it says nothing after. */
  #stops = 0

  constructor(probes: readonly ProviderProcessProbe[]) {
    for (const probe of probes) {
      this.#slots.set(probe.provider, {
        probe,
        timer: null,
        controller: null,
        reading: null,
        sessions: [],
        lastAvailableAt: 0,
        failures: 0,
      })
    }
  }

  onChange(listener: (snapshot: ProviderActivitySnapshot) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    for (const provider of this.#slots.keys()) this.#schedule(provider, 0)
  }

  /** Looks no more until `start`, keeping what each harness last said; a probe under way still says its own. */
  pause(): void {
    this.#running = false
    for (const slot of this.#slots.values()) {
      if (slot.timer) clearTimeout(slot.timer)
      slot.timer = null
    }
  }

  get running(): boolean { return this.#running }

  stop(): void {
    this.#running = false
    this.#stops += 1
    for (const slot of this.#slots.values()) {
      if (slot.timer) clearTimeout(slot.timer)
      slot.timer = null
      slot.controller?.abort()
      slot.controller = null
    }
  }

  /** Something may have started or ended (a provider process Mako started or saw exit): every harness looks now. */
  nudge(): void {
    if (!this.#running) return
    for (const [provider, slot] of this.#slots) if (!slot.controller) this.#schedule(provider, 0)
  }

  snapshot(): ProviderActivitySnapshot[] {
    return [...this.#slots.entries()].map(([provider, slot]) => ({
      provider,
      sessions: slot.sessions,
    }))
  }

  /**
   * One look at every harness now, whether or not the engine runs, done when each has answered: for whoever needs the
   * answer while nobody else does (a reply to a session, decided with no window open). Looks under way are joined.
   */
  look(): Promise<void> {
    this.#looking ??= Promise.all([...this.#slots.keys()].map((provider) => this.#slots.get(provider)?.reading ?? this.#read(provider)))
      .then(() => { this.#looking = undefined })
    return this.#looking
  }

  #schedule(provider: string, delay: number): void {
    const slot = this.#slots.get(provider)
    if (!slot || !this.#running) return
    if (slot.timer) clearTimeout(slot.timer)
    slot.timer = setTimeout(() => {
      slot.timer = null
      void this.#run(provider)
    }, delay)
    slot.timer.unref()
  }

  async #run(provider: string): Promise<void> {
    const slot = this.#slots.get(provider)
    if (!slot || !this.#running) return
    const available = await (slot.reading ?? this.#read(provider))
    if (!this.#running) return
    const base = slot.probe.pollIntervalMs ?? 5_000
    // A harness with nothing open looks again in half a minute, not every few seconds: on an idle Mac that was a
    // process table or an `lsof` every 3-5 s a harness. One Mako starts says so at once (`nudge`); one started in a
    // terminal or its own app is seen within that half minute.
    const delay = available
      ? slot.sessions.length ? base : Math.max(base, slot.probe.idlePollMs ?? IDLE_POLL_MS)
      : Math.min(60_000, base * 2 ** Math.min(slot.failures, 4))
    this.#schedule(provider, delay)
  }

  /** Asks one harness's probe and keeps what it said; whether it answered. A `stop` meanwhile ends it, and nothing is kept. */
  #read(provider: string): Promise<boolean> {
    const slot = this.#slots.get(provider)
    if (!slot) return Promise.resolve(false)
    const reading = this.#probe(provider, slot).finally(() => {
      if (slot.reading === reading) slot.reading = null
    })
    slot.reading = reading
    return reading
  }

  async #probe(provider: string, slot: ProbeSlot): Promise<boolean> {
    const controller = new AbortController()
    slot.controller = controller
    const stops = this.#stops
    const timeout = setTimeout(
      () => controller.abort(),
      slot.probe.timeoutMs ?? 4_000
    )
    timeout.unref()
    let available = false
    let sessions = slot.sessions
    try {
      const result = await slot.probe.probe(controller.signal)
      if (result.kind === "available") {
        available = true
        sessions = normalizeSessions(result.sessions)
        slot.lastAvailableAt = Date.now()
        slot.failures = 0
      } else {
        slot.failures += 1
      }
    } catch {
      slot.failures += 1
    } finally {
      clearTimeout(timeout)
      if (slot.controller === controller) slot.controller = null
    }
    if (stops !== this.#stops) return false
    const staleAfter = slot.probe.staleAfterMs ?? 15_000
    if (!available && Date.now() - slot.lastAvailableAt >= staleAfter)
      sessions = []
    if (!sameSessions(slot.sessions, sessions)) {
      slot.sessions = sessions
      const snapshot = { provider, sessions }
      for (const listener of this.#listeners) listener(snapshot)
    }
    return available
  }
}
