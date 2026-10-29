import { AccountEventSchema, accountStream } from "@mako/protocol/account-events"
import { AccountSessions, isAccountListEvent } from "@mako/protocol/account-sessions"
import { SessionListingsSchema, type ArchivedThread, type ListedSession, type SessionListings } from "@mako/protocol/thread-listing"
import type { WaitingMessage } from "@mako/protocol/waiting"
import { followAgainInMs, type Subscription } from "@mako/protocol"
import { errorMessage, type FailureBoundary } from "@mako/host/contracts/error-message"
import { z } from "zod"
import { createHook, createStore, type StorePatch } from "@/state/store"
import { GatewayError, SignedOutError, type Gateway } from "./gateway"
import { webSync } from "./sync-readings"

/** One of the account's devices as a list names it. */
export interface WebDevice {
  id: string
  kind: string
  name: string
  platform: string
}

const WebDeviceSchema = z.object({ id: z.string(), kind: z.string(), name: z.string(), platform: z.string() }) satisfies z.ZodType<WebDevice>
/** The account's devices, as `GET /v1/devices` answers. */
const DevicesSchema = z.object({ devices: z.array(WebDeviceSchema) })

/** The last thing that went wrong following the list, and the correlation ID its gateway logs carry. */
interface ListFailure {
  message: string
  at: number
  correlationId?: string
}

/**
 * The account's list as this browser holds it. `cached`: painted from this browser's storage, not yet confirmed by the
 * gateway; `live`: read and followed; `reconnecting`: the stream ended and is being followed again, the rows as last
 * heard (`asOf`).
 */
export interface AccountListState {
  phase: "starting" | "cached" | "live" | "reconnecting" | "signed-out"
  rows: readonly ListedSession[]
  waiting: ReadonlyMap<string, readonly WaitingMessage[]>
  quiet: ReadonlyMap<string, string>
  archived: readonly ArchivedThread[]
  devices: ReadonlyMap<string, WebDevice>
  /** The account stream's number the rows stand at. */
  seq?: number
  /** When the rows were last known to be current, in ms since the epoch. */
  asOf?: number
  /** The last thing that went wrong following the list, for Diagnostics. */
  failure?: ListFailure
}

export const accountListStore = createStore<AccountListState>({
  phase: "starting",
  rows: [],
  waiting: new Map(),
  quiet: new Map(),
  archived: [],
  devices: new Map(),
})
export const useAccountList = createHook(accountListStore)

/** What a list paints from before the gateway answers: the last one this browser saw, and when. */
type Cached = { at: number; listings: SessionListings; devices: WebDevice[] }
const CachedSchema = z.object({ at: z.number(), listings: SessionListingsSchema, devices: z.array(WebDeviceSchema) }) satisfies z.ZodType<Cached>

/** A number its object may have given out but never kept, which it says in its place. */
const LostSchema = z.object({ type: z.literal("lost") }).loose()
/** Kept to storage at most this often: a busy account changes its list several times a second. */
const SAVE_MS = 5_000

/**
 * Follows the account's list for this browser: `GET /v1/sessions`, then the account's stream after its number, held by
 * the same `AccountSessions` a Mac's host holds, so a browser and a Mac can't list the account differently. Followed
 * again from a fresh read whenever the stream ends; a wake (the page shown again, the network back) cuts the wait
 * short. Nothing here wakes a machine or a Mac.
 */
export class AccountList {
  readonly #gateway: Gateway
  readonly #accountId: string
  readonly #list = new AccountSessions()
  readonly #storageKey: string
  #subscription: Subscription | undefined
  #stopped = false
  #wake: (() => void) | undefined
  #saveTimer: ReturnType<typeof setTimeout> | undefined
  /** Whether this visit kept the list once already. */
  #saved = false
  /** Signed out: nothing is kept from now. */
  #forgotten = false
  #devicesAsked = 0

  constructor(gateway: Gateway, accountId: string) {
    this.#gateway = gateway
    this.#accountId = accountId
    this.#storageKey = `mako:web:list:${accountId}`
    this.#paintCached()
  }

  start(): void {
    void this.#run()
  }

  /** Follow again now: the page came back into view, or the network did. */
  wake(): void {
    this.#wake?.()
  }

  stop(): void {
    this.#stopped = true
    this.#subscription?.close()
    this.#wake?.()
    clearTimeout(this.#saveTimer)
  }

  /** Drops the list this browser kept to paint its next visit: signed out, it isn't this browser's to show. */
  forget(): void {
    this.#forgotten = true
    clearTimeout(this.#saveTimer)
    this.#saveTimer = undefined
    localStorage.removeItem(this.#storageKey)
  }

  /** Every listed Session, as the list stands now. */
  rows(): ListedSession[] {
    return [...this.#list.sessions().values()]
  }

  /** A listed Session by its conversation, as the list stands now. */
  byConversation(conversation: string): ListedSession | undefined {
    for (const row of this.#list.sessions().values()) if (row.conversation === conversation) return row
    for (const archived of this.#list.archived().values()) for (const row of archived.sessions) if (row.conversation === conversation) return row
    return undefined
  }

  /**
   * The list read again now, as a pull to refresh asks: the same read a follow starts with, kept if it's newer than
   * what the stream brought, and the socket checked at once. The follow goes on as it was.
   */
  async refresh(): Promise<void> {
    this.#gateway.wake()
    const listings = SessionListingsSchema.parse(await this.#gateway.rest("GET", "/v1/sessions"))
    if (this.#list.seq === undefined || listings.seq >= this.#list.seq) this.#list.listed(listings)
    await this.refreshDevices().catch((error) => this.#failed({ error }))
    this.#publish("live")
  }

  /** The account's devices, read again: a device that joined is named once a row names it. */
  async refreshDevices(): Promise<void> {
    this.#devicesAsked = Date.now()
    const { devices } = DevicesSchema.parse(await this.#gateway.rest("GET", "/v1/devices"))
    accountListStore.set({ devices: new Map(devices.map((device) => [device.id, device])) })
  }

  async #run(): Promise<void> {
    let failures = 0
    while (!this.#stopped) {
      try {
        const listings = SessionListingsSchema.parse(await this.#gateway.rest("GET", "/v1/sessions"))
        this.#list.listed(listings)
        if (!this.#devicesAsked || this.#unnamedDevice()) await this.refreshDevices().catch((error) => this.#failed({ error }))
        this.#publish("live")
        failures = 0
        const subscription = this.#gateway.session.subscribe({ stream: accountStream(this.#accountId), after: listings.seq })
        this.#subscription = subscription
        // The stream is numbered with no gaps: one skipped, or said lost, means the list may be wrong, and it's read
        // whole again at once.
        let last = listings.seq
        for (;;) {
          const frame = await subscription.next()
          if (frame.seq <= last) continue
          const skipped = frame.seq > last + 1
          const decoded = frame.event.decode()
          const lost = LostSchema.safeParse(decoded).success
          if (skipped || lost) webSync.listGap({ after: last, seq: frame.seq, why: skipped ? "skipped" : "lost" })
          last = frame.seq
          webSync.listHeard(frame.seq)
          if (skipped || lost) break
          const parsed = AccountEventSchema.safeParse(decoded)
          // A kind of event this build doesn't know is passed over, never refused.
          if (!parsed.success || !isAccountListEvent(parsed.data)) continue
          if (parsed.data.type === "sessions-listed") for (const row of parsed.data.sessions) if (row.changedAt) webSync.listChanged(row.changedAt)
          if (!this.#list.heard({ seq: frame.seq, event: parsed.data })) continue
          if (this.#unnamedDevice() && Date.now() - this.#devicesAsked > 10_000) void this.refreshDevices().catch((error) => this.#failed({ error }))
          this.#publish("live")
        }
        subscription.close()
        continue
      } catch (error) {
        if (this.#stopped) return
        if (error instanceof SignedOutError) {
          accountListStore.set({ phase: "signed-out" })
          return
        }
        this.#failed({ error })
        if (accountListStore.get().phase === "live") accountListStore.set({ phase: "reconnecting" })
      }
      await this.#pause(followAgainInMs(failures++))
    }
  }

  #unnamedDevice(): boolean {
    const { devices } = accountListStore.get()
    for (const row of this.#list.sessions().values()) if (row.runsOn.kind === "device" && !devices.has(row.runsOn.deviceId)) return true
    return false
  }

  #pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms)
      function done() {
        clearTimeout(timer)
        resolve()
      }
      this.#wake = done
    })
  }

  #failed({ error }: FailureBoundary): void {
    const failure: ListFailure = { message: errorMessage({ error }), at: Date.now() }
    // Only the gateway's refusals carry a correlation ID; a stream that ended has none to quote.
    if (error instanceof GatewayError && error.correlationId) failure.correlationId = error.correlationId
    accountListStore.set({ failure })
  }

  #publish(phase: AccountListState["phase"]): void {
    const waiting = new Map<string, readonly WaitingMessage[]>()
    for (const [session, messages] of this.#list.allWaiting()) waiting.set(session, messages)
    const quiet = new Map<string, string>()
    for (const row of this.#list.sessions().values()) {
      if (row.runsOn.kind !== "device") continue
      const since = this.#list.quietSince(row.runsOn.deviceId)
      if (since) quiet.set(row.runsOn.deviceId, since)
    }
    const next: StorePatch<AccountListState> = {
      phase,
      rows: [...this.#list.sessions().values()],
      waiting,
      quiet,
      archived: [...this.#list.archived().values()].sort((left, right) => Date.parse(right.archivedAt) - Date.parse(left.archivedAt)),
      asOf: Date.now(),
    }
    if (this.#list.seq !== undefined) next.seq = this.#list.seq
    accountListStore.set(next)
    this.#saveSoon()
  }

  /**
   * Keeps the list for the next visit: the first one heard at once (a phone opened for a glance is often closed within
   * seconds), then at most every `SAVE_MS`, and whatever is pending as the page goes away.
   */
  #saveSoon(): void {
    if (this.#saveTimer) return
    if (!this.#saved) return this.save()
    this.#saveTimer = setTimeout(() => this.save(), SAVE_MS)
  }

  /** Keeps the list as it stands now, for the next visit to paint before the gateway answers. */
  save(): void {
    clearTimeout(this.#saveTimer)
    this.#saveTimer = undefined
    const state = accountListStore.get()
    if (this.#forgotten || (state.phase !== "live" && state.phase !== "reconnecting")) return
    const cached: Cached = {
      at: state.asOf ?? Date.now(),
      listings: { sessions: [...state.rows], seq: state.seq ?? 0, waiting: [...state.waiting.values()].flat(), quiet: [...state.quiet].map(([deviceId, since]) => ({ deviceId, since })), archived: [...state.archived] },
      devices: [...state.devices.values()],
    }
    try {
      localStorage.setItem(this.#storageKey, JSON.stringify(cached))
      this.#saved = true
    } catch {
      // Storage full or refused: the next visit paints once the gateway answers instead.
    }
  }

  /** The last list this browser saw, painted at once and marked as not yet current. */
  #paintCached(): void {
    let cached: Cached | undefined
    try {
      const text = localStorage.getItem(this.#storageKey)
      cached = text ? CachedSchema.safeParse(JSON.parse(text)).data : undefined
    } catch {
      cached = undefined
    }
    if (!cached) return
    const list = new AccountSessions()
    list.listed(cached.listings)
    const quiet = new Map((cached.listings.quiet ?? []).map(({ deviceId, since }) => [deviceId, since]))
    accountListStore.set({
      phase: "cached",
      rows: [...list.sessions().values()],
      waiting: new Map(list.allWaiting()),
      quiet,
      archived: cached.listings.archived ?? [],
      devices: new Map(cached.devices.map((device) => [device.id, device])),
      asOf: cached.at,
    })
  }
}
