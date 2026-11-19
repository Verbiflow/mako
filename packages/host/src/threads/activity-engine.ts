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

export class ProviderActivityEngine {
  readonly #slots = new Map<string, ProbeSlot>()
  readonly #listeners = new Set<(snapshot: ProviderActivitySnapshot) => void>()
  #running = false

  constructor(probes: readonly ProviderProcessProbe[]) {
    for (const probe of probes) {
      this.#slots.set(probe.provider, {
        probe,
        timer: null,
        controller: null,
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

  stop(): void {
    this.#running = false
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
    if (!slot || !this.#running || slot.controller) return
    const controller = new AbortController()
    slot.controller = controller
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
      slot.controller = null
    }
    if (!this.#running) return
    const staleAfter = slot.probe.staleAfterMs ?? 15_000
    if (!available && Date.now() - slot.lastAvailableAt >= staleAfter)
      sessions = []
    if (!sameSessions(slot.sessions, sessions)) {
      slot.sessions = sessions
      const snapshot = { provider, sessions }
      for (const listener of this.#listeners) listener(snapshot)
    }
    const base = slot.probe.pollIntervalMs ?? 5_000
    // A harness with nothing open looks again in half a minute, not every few seconds: on an idle Mac that was a
    // process table or an `lsof` every 3-5 s a harness. One Mako starts says so at once (`nudge`); one started in a
    // terminal or its own app is seen within that half minute.
    const delay = available
      ? sessions.length ? base : Math.max(base, slot.probe.idlePollMs ?? IDLE_POLL_MS)
      : Math.min(60_000, base * 2 ** Math.min(slot.failures, 4))
    this.#schedule(provider, delay)
  }
}
