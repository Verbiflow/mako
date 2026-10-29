import { readFile } from "node:fs/promises"
import type { SyncRecorder } from "../contracts/sync-readings.js"
import { join } from "node:path"
import type { ReportedSession } from "@mako/protocol/thread-listing"
import { BACKFILL_PROGRESS, BackfillProgressSchema } from "@mako/sessions/record-backfill"
import type { RecordsLink } from "@mako/sessions/record-sync"
import { SYNC_TIERS, type CatalogSyncStatus, type SyncFailure, type SyncScope } from "@mako/sessions/scoped-uploads"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { MethodTable } from "../base/methods.js"
import type { PowerReading } from "../base/power.js"
import type { SyncStatus } from "../contracts/sync-status.js"
import { busyRow, syncOrder, threadActivity } from "./session-report.js"
import { syncTier } from "./sync-window.js"

/** Catching up waits below this battery percentage, and in Low Power Mode; a Session at work goes up as it's written regardless. */
export const UPLOAD_BATTERY_FLOOR = 20
/** How often the power is read: a change of power source isn't worth a process a second. */
const POWER_EVERY_MS = 60_000

/** Where this device's two forms go in the account, its reading copies and its originals; or why nothing goes. */
export type UploadLinks = { state: "on"; copies: RecordsLink; originals: RecordsLink } | { state: "off"; reason: "signed-out" | "no-cloud" }

/** What uploads read of the host: the Sessions the account lists of it, where they go, its power, and the catalog's sync. */
export type UploadSources = {
  /** The Sessions the account lists of this host (`SessionPublisher.listed`); undefined until they're known. */
  rows(): readonly ReportedSession[] | undefined
  /** Where the catalog reads a native session, by its harness and ID; undefined for one it doesn't list. */
  path(harness: string, nativeId: string): string | undefined
  /** Where this device's copies and originals go in the account, while it's signed in with the cloud; else why not. */
  links(): Promise<UploadLinks>
  power(): Promise<PowerReading>
  /** The catalog's sync (`HostCatalog.scopeSync`, `syncCopies`, `syncOriginals`, `syncStatus`). */
  scope(scope: SyncScope): Promise<void>
  copies(link: RecordsLink | null): Promise<void>
  originals(link: RecordsLink | null): Promise<void>
  status(): Promise<CatalogSyncStatus | null>
  /** The record store's backfill, as its last pass wrote it beside the store; undefined before the first. */
  backfill(): Promise<Backfill | undefined>
  now(): number
  /** The status changed (`SessionUploads.status`): what follows it hears so, rather than asking on a timer. */
  statusChanged?(status: SyncStatus): void
}

/**
 * The order a device's Sessions go up in, both forms alike: the ones at work first, since another device is likeliest
 * to open one of those, then each Thread whole, the most recently worked in first, each Session by its native session
 * and where the catalog reads it, with its tier; and whether catching up waits, on a low battery or in Low Power Mode.
 * A Session with no native session yet, or one the catalog doesn't list, waits until it has.
 */
export function uploadScope(rows: readonly ReportedSession[], power: PowerReading, pathOf: (harness: string, nativeId: string) => string | undefined, now: number): SyncScope {
  const threads = threadActivity(rows)
  const seen = new Set<string>()
  const sessions: SyncScope["sessions"] = []
  for (const row of [...rows].sort((left, right) => syncOrder(left, right, threads))) {
    if (!row.nativeId) continue
    const key = `${row.harness}\n${row.nativeId}`
    const path = row.capture?.path ?? pathOf(row.harness, row.nativeId)
    const tier = syncTier(Date.parse(threads.get(row.thread) ?? row.activityAt), busyRow(row), now)
    if (!path || !tier || seen.has(key)) continue
    seen.add(key)
    sessions.push({ harness: row.harness, nativeId: row.nativeId, path, thread: row.thread, busy: busyRow(row), tier })
  }
  const paused = power.lowPower || (power.onBattery && (power.percent ?? 100) < UPLOAD_BATTERY_FLOOR)
  return { sessions, paused }
}

/**
 * Keeps this device's Sessions in the account, in `uploadScope`'s order: each as Mako draws it (its reading copy, for
 * any device to read) and as its harness wrote it (its originals, for continuing it anywhere), both pushed by the
 * catalog from stores that keep what the account holds. Said again on each tick only when something changed; the
 * scope goes before the links. Nothing leaves the Mac without the cloud. Its status is read from the catalog on each
 * tick, and a failure the catalog's process keeps is logged here once, with the gateway's correlation ID.
 */
export class SessionUploads {
  readonly #sources: UploadSources
  #scopeKey: string | undefined
  #links: string | undefined
  #paused: boolean | undefined
  #power: { reading: PowerReading; at: number } | undefined
  #status: SyncStatus = { state: "off", reason: "signed-out" }
  #statusText = JSON.stringify(this.#status)
  /** Failures already logged, by when and what: the catalog keeps the newest few until they're pushed. */
  readonly #logged = new Set<string>()

  constructor(sources: UploadSources) {
    this.#sources = sources
  }

  /** How this device's sync stands, as of the last tick. */
  status(): SyncStatus {
    return this.#status
  }

  async tick(): Promise<void> {
    const links = await this.#sources.links()
    if (links.state === "off") {
      if (this.#links) {
        this.#links = undefined
        await this.#sources.copies(null)
        await this.#sources.originals(null)
        hostLog("sync", "this device's Sessions stopped going to the account", { reason: links.reason })
      }
      this.#said({ state: "off", reason: links.reason })
      return
    }
    const rows = this.#sources.rows()
    if (!rows) return
    const scope = uploadScope(rows, await this.#reading(), (harness, nativeId) => this.#sources.path(harness, nativeId), this.#sources.now())
    const scopeKey = JSON.stringify(scope)
    if (scopeKey !== this.#scopeKey) {
      await this.#sources.scope(scope)
      this.#scopeKey = scopeKey
      if (scope.paused !== this.#paused) {
        this.#paused = scope.paused
        hostLog("sync", scope.paused ? "catching up waits: on a low battery or in Low Power Mode" : "catching up goes on", { sessions: scope.sessions.length })
      }
    }
    const linksKey = JSON.stringify([links.copies.id, links.copies.authorization, links.originals.id, links.originals.authorization])
    if (linksKey !== this.#links) {
      const first = this.#links === undefined
      await this.#sources.copies(links.copies)
      await this.#sources.originals(links.originals)
      this.#links = linksKey
      if (first) hostLog("sync", "this device's Sessions go to the account", { sessions: scope.sessions.length, paused: String(scope.paused) })
    }
    await this.#read(scope)
  }

  async #read(scope: SyncScope): Promise<void> {
    const [catalog, backfill] = await Promise.all([
      this.#sources.status().catch((error: Error) => {
        hostWarn("sync", "the catalog's sync status couldn't be read", { error: error.message })
        return null
      }),
      this.#sources.backfill().catch(() => undefined),
    ])
    for (const [form, status] of [["copies", catalog?.copies], ["originals", catalog?.originals]] as const)
      for (const failure of status?.failures ?? []) this.#logFailure(form, failure)
    this.#said(syncStatusOf(scope, catalog, backfill))
  }

  #said(status: SyncStatus): void {
    this.#status = status
    const text = JSON.stringify(status)
    if (text === this.#statusText) return
    this.#statusText = text
    this.#sources.statusChanged?.(status)
  }

  #logFailure(form: "copies" | "originals", failure: SyncFailure): void {
    const key = `${form}\n${failure.at}\n${failure.harness}\n${failure.nativeId}`
    if (this.#logged.has(key)) return
    this.#logged.add(key)
    if (this.#logged.size > 200) this.#logged.delete(this.#logged.values().next().value ?? key)
    hostWarn("sync", failure.conflict ? "records went on in two places; the account's stand" : form === "copies" ? "a Session's copy didn't go to the account" : "a Session's records didn't go to the account", {
      harness: failure.harness, nativeId: failure.nativeId, error: failure.message, ...failure.correlationId && { correlationId: failure.correlationId },
    })
  }

  async #reading(): Promise<PowerReading> {
    const now = this.#sources.now()
    if (!this.#power || now - this.#power.at >= POWER_EVERY_MS) this.#power = { reading: await this.#sources.power(), at: now }
    return this.#power.reading
  }
}

/**
 * The status the window shows, from the catalog's two forms: a Session is in the cloud once both are whole there, its
 * copy current and its records pushed through their last capture. Counted by tier; Threads by the Sessions' Threads.
 */
export function syncStatusOf(scope: SyncScope, catalog: CatalogSyncStatus | null, backfill: Backfill | undefined): SyncStatus {
  if (!catalog?.copies && !catalog?.originals) return { state: "starting", sessions: scope.sessions.length }
  const tiers = SYNC_TIERS.map((tier) => ({ tier, ...catalog.tiers[tier] }))
  const failures = [...(catalog.copies?.failures ?? []), ...(catalog.originals?.failures ?? [])].sort((left, right) => right.at - left.at).slice(0, 5)
  const lastSuccessAt = Math.max(catalog.copies?.lastSuccessAt ?? 0, catalog.originals?.lastSuccessAt ?? 0)
  const status: SyncStatus = {
    state: failures.length ? "failing" : scope.paused ? "paused" : "syncing",
    sessions: scope.sessions.length,
    tiers,
    sending: [...(catalog.copies?.sending ?? []), ...(catalog.originals?.sending ?? [])].length,
    stale: catalog.stale,
    failures: failures.map(({ at, harness, nativeId, message, correlationId }) => ({ at, harness, nativeId, message, ...correlationId && { correlationId } })),
    ...lastSuccessAt > 0 && { lastSuccessAt },
    ...backfill && { backfill },
  }
  if (status.state === "syncing" && tiers.every((tier) => tier.inCloud === tier.sessions)) status.state = "synced"
  return status
}

type Backfill = NonNullable<Extract<SyncStatus, { tiers: unknown }>["backfill"]>

/**
 * The record store's backfill as its last pass wrote it beside the store (`backfill.json`), whichever process ran it:
 * how many of this Mac's sessions it has taken; undefined before the first pass.
 */
export async function readBackfill(records: string): Promise<Backfill | undefined> {
  const text = await readFile(join(records, BACKFILL_PROGRESS), "utf8").catch(() => undefined)
  const parsed = text === undefined ? undefined : BackfillProgressSchema.safeParse(JSON.parse(text))
  if (!parsed?.success) return undefined
  const { sessions, done, startedAt, endedAt } = parsed.data
  return { sessions, done, startedAt, ...endedAt !== undefined && { endedAt } }
}

/**
 * How this device's Sessions stand in the account, for Settings (`SessionUploads.status`), off where nothing uploads;
 * and how its sync goes, for Diagnostics (`SyncRecorder.readings`).
 */
export function declareSyncMethods(methods: MethodTable, uploads: Pick<SessionUploads, "status"> | undefined, readings: Pick<SyncRecorder, "readings">): void {
  methods.handle("mako:sync-status", () => uploads?.status() ?? { state: "off", reason: "signed-out" })
  methods.handle("mako:sync-readings", () => readings.readings())
}
