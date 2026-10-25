import type { ReportedSession } from "@mako/protocol/thread-listing"
import type { CopyScope } from "@mako/sessions/reading-copies"
import type { RecordsLink } from "@mako/sessions/record-sync"
import { hostLog } from "../base/host-log.js"
import type { PowerReading } from "../base/power.js"

/** Catching up waits below this battery percentage, and in Low Power Mode; a Session at work goes up as it's written regardless. */
export const UPLOAD_BATTERY_FLOOR = 20
/** How often the power is read: a change of power source isn't worth a process a second. */
const POWER_EVERY_MS = 60_000

/** What uploads read of the host: the Sessions the account lists of it, where its copies go, its power, and the catalog's sync. */
export type UploadSources = {
  /** The Sessions the account lists of this host (`SessionPublisher.listed`); undefined until they're known. */
  rows(): readonly ReportedSession[] | undefined
  /** Where the catalog reads a native session, by its harness and ID (the rail's row); undefined for one it doesn't list. */
  path(harness: string, nativeId: string): string | undefined
  /** Where this device's records go in the account, while it's signed in with the cloud; undefined otherwise. */
  link(): Promise<RecordsLink | undefined>
  power(): Promise<PowerReading>
  /** The catalog's reading copies (`HostCatalog.scopeCopies`, `HostCatalog.syncCopies`). */
  scope(scope: CopyScope): Promise<void>
  sync(link: RecordsLink | null): Promise<void>
  now(): number
}

const busy = (row: ReportedSession) => row.state === "working" || row.state === "waiting" || row.state === "moving"

/**
 * The order a device's copies go up in: its Sessions at work first, since another device is likeliest to open one of
 * those, then the rest newest first, each by its native session and where the catalog reads it; and whether catching
 * up waits, on a low battery or in Low Power Mode. A Session with no native session yet, or one the rail doesn't list,
 * waits until it has.
 */
export function uploadScope(rows: readonly ReportedSession[], power: PowerReading, pathOf: (harness: string, nativeId: string) => string | undefined): CopyScope {
  const seen = new Set<string>()
  const sessions: CopyScope["sessions"] = []
  for (const row of [...rows.filter(busy), ...rows.filter((row) => !busy(row))]) {
    if (!row.nativeId) continue
    const key = `${row.harness}\n${row.nativeId}`
    const path = row.capture?.path ?? pathOf(row.harness, row.nativeId)
    if (!path || seen.has(key)) continue
    seen.add(key)
    sessions.push({ harness: row.harness, nativeId: row.nativeId, path, busy: busy(row) })
  }
  const paused = power.lowPower || (power.onBattery && (power.percent ?? 100) < UPLOAD_BATTERY_FLOOR)
  return { sessions, paused }
}

/**
 * Keeps the account's reading copies of this device's Sessions in step: the catalog copies each listed Session as Mako
 * draws it when it changes and its turn comes (`ReadingCopies`), in `uploadScope`'s order, to the device's own records
 * in the account. Said again on each tick only when something changed; the scope goes before the link. Nothing leaves
 * the Mac without the cloud.
 */
export class SessionUploads {
  readonly #sources: UploadSources
  #scope: string | undefined
  #link: string | undefined
  #paused: boolean | undefined
  #power: { reading: PowerReading; at: number } | undefined

  constructor(sources: UploadSources) {
    this.#sources = sources
  }

  async tick(): Promise<void> {
    const link = await this.#sources.link()
    if (!link) {
      if (this.#link) {
        this.#link = undefined
        await this.#sources.sync(null)
        hostLog("sync", "this device's copies stopped going to the account")
      }
      return
    }
    const rows = this.#sources.rows()
    if (!rows) return
    const scope = uploadScope(rows, await this.#reading(), (harness, nativeId) => this.#sources.path(harness, nativeId))
    const scopeKey = JSON.stringify(scope)
    if (scopeKey !== this.#scope) {
      await this.#sources.scope(scope)
      this.#scope = scopeKey
      if (scope.paused !== this.#paused) {
        this.#paused = scope.paused
        hostLog("sync", scope.paused ? "catching up waits: on a low battery or in Low Power Mode" : "catching up goes on", { sessions: scope.sessions.length })
      }
    }
    const linkKey = `${link.id}\n${link.authorization}`
    if (linkKey === this.#link) return
    const first = this.#link === undefined
    await this.#sources.sync(link)
    this.#link = linkKey
    if (first) hostLog("sync", "this device's copies go to the account", { sessions: scope.sessions.length, paused: String(scope.paused) })
  }

  async #reading(): Promise<PowerReading> {
    const now = this.#sources.now()
    if (!this.#power || now - this.#power.at >= POWER_EVERY_MS) this.#power = { reading: await this.#sources.power(), at: now }
    return this.#power.reading
  }
}
