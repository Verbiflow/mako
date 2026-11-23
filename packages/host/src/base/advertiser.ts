import type { Advertisement } from "@mako/protocol"
import { satisfies, type Capability, type Grant, type Slots } from "@mako/protocol/borrow"

/** This device's room as Fins and lent operations share it: its own Fins at work, out of what it runs at once. */
export type AdvertisedRoom = { slots: Slots; load?: string }

/** Where an advertisement goes: the runtime link (false while it isn't up), or this device's own broker. */
export type AdvertisementSink = (advertisement: Advertisement) => boolean | Promise<void> | void

export interface AdvertiserDeps {
  probe(): Promise<Capability[]>
  /** The grants that stand, wherever this device reads them (its own brokers, the account's): what the person lends. */
  lending(): Promise<readonly Grant[]>
  /** The names this device goes by in a grant's `source.devices`. */
  devices(): Promise<readonly string[]>
  room(): AdvertisedRoom
  sinks: readonly AdvertisementSink[]
  now?(): number
  log?(message: string, fields: Record<string, string | number>): void
}

/**
 * What of a device's capabilities the person lends: each one some standing grant over capable devices wants (one of its
 * `requires` matches it), where the grant names no devices or names this one. Nothing lent, nothing advertised; what
 * the broker issues is decided again at issuance.
 */
export function lentCapabilities(capabilities: readonly Capability[], grants: readonly Grant[], devices: readonly string[]): Capability[] {
  const lending = grants.flatMap((grant) =>
    grant.source.kind === "capable" && (!grant.source.devices || grant.source.devices.some((device) => devices.includes(device))) ? grant.source.requires : []
  )
  return capabilities.filter((capability) => lending.some((query) => satisfies([capability], [query])))
}

/** How often a device says what it can serve though nothing changed, so a broker never holds a stale picture of it. */
export const ADVERTISE_EVERY_MS = 60 * 60_000

/**
 * What this device advertises to borrowing's brokers (`borrow.ts`): what of its capabilities the person lends, as last
 * probed, and its room. It says so when either changes (an install, a grant given, a slot freed), when its runtime link
 * enrols, and hourly; an unchanged room between those says nothing. Each sink is told in turn, and one that fails
 * never keeps another from hearing.
 */
export class Advertiser {
  readonly #deps: AdvertiserDeps
  #capabilities: Capability[] | undefined
  #probedAt = 0
  #probing: Promise<Capability[]> | undefined
  /** What the sinks were last told, without its time: an advertisement equal to it isn't sent again until it's due. */
  #said: string | undefined
  #saidAt = 0

  constructor(deps: AdvertiserDeps) {
    this.#deps = deps
  }

  /** The advertisement as it stands, for a link enrolling now; undefined before the first probe ends. */
  current(): Advertisement | undefined {
    if (!this.#capabilities) return undefined
    const room = this.#deps.room()
    return { capabilities: this.#capabilities, slots: room.slots, ...(room.load && { load: room.load }), at: this.#now() }
  }

  /** Probes again (something may have been installed), and says what changed. */
  async probe(): Promise<void> {
    this.#probing ??= Promise.all([this.#deps.probe(), this.#deps.lending().catch((): Grant[] => []), this.#deps.devices().catch((): string[] => [])])
      .then(([capabilities, grants, devices]) => lentCapabilities(capabilities, grants, devices))
      .finally(() => {
        this.#probing = undefined
      })
    this.#capabilities = await this.#probing
    this.#probedAt = this.#now()
    this.#say(false)
  }

  /** The room may have changed (a Fin started or ended, a lease came or went): said only when it did. */
  roomChanged(): void {
    if (this.#capabilities) this.#say(false)
  }

  /** The hourly word: probed again if an hour has passed, and said whether or not anything changed. */
  async due(): Promise<void> {
    if (!this.#capabilities || this.#now() - this.#probedAt >= ADVERTISE_EVERY_MS) await this.probe()
    if (this.#now() - this.#saidAt >= ADVERTISE_EVERY_MS) this.#say(true)
  }

  #say(always: boolean): void {
    const advertisement = this.current()
    if (!advertisement) return
    const text = JSON.stringify([advertisement.capabilities, advertisement.slots, advertisement.load])
    if (!always && text === this.#said) return
    this.#said = text
    this.#saidAt = advertisement.at
    this.#deps.log?.("advertised", { capabilities: advertisement.capabilities.length, used: advertisement.slots.used, of: advertisement.slots.of })
    for (const sink of this.#deps.sinks) {
      try {
        const sent = sink(advertisement)
        if (sent instanceof Promise) sent.catch((error: Error) => this.#deps.log?.("an advertisement wasn't taken", { error: error.message }))
      } catch (error) {
        this.#deps.log?.("an advertisement wasn't taken", { error: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now()
  }
}
