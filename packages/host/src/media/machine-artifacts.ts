import { lstat, readdir, rm } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import type { HostJobs } from "../base/host-jobs.js"
import type { ArtifactCapState, ArtifactKind } from "../contracts/machine-agent.js"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { PAGES_FOLDER } from "./page-copy.js"
import { MEDIA_DATABASE } from "./turn-media.js"

/**
 * A cloud machine's recordings and artifacts, held under a cap of their own so they never take the room a person's
 * builds need: computer use's recordings, its screenshots and the outputs it spills to files, and the copies of media
 * the Thread's turns showed. Each kind keeps its newest within its cap, and the oldest go first. A Mac's are left to
 * its temp folder and the person's disk.
 *
 * Nothing changed within `graceMs` is removed, whatever the cap: a recording still being written, a screenshot the
 * running turn is about to read. A recording is one folder, removed whole; screenshots and spills are files of their
 * own, so a task that runs for hours loses its oldest first rather than everything. A media copy removed is decided
 * again from its original the next time a window asks (`TurnMedia`), as on a machine that hopped.
 */

/** The host job that holds them to their caps, by its name in the host's jobs. */
export const ARTIFACTS_JOB = "hold the machine's recordings and artifacts to their caps"
const SWEEP_EVERY_MS = 5 * 60_000
const FIRST_SWEEP_MS = 60_000
/** Younger than this, a file or recording is still in use. */
const GRACE_MS = 15 * 60_000
const GIB = 1024 ** 3

/**
 * How an entry at a kind's top is counted: `one`, one thing (a file, or a folder removed whole, its age its newest
 * file's); `each`, a folder whose entries are each one thing; `files`, a folder whose every file is one; `keep`, never
 * counted or removed.
 */
export type ArtifactEntry = "one" | "each" | "files" | "keep"
export type ArtifactPlace = { kind: ArtifactKind; root: string; capBytes: number; entry: (name: string, folder: boolean) => ArtifactEntry }

/**
 * The places a machine's host writes them: control's artifacts and recordings, as `@mako/control` names their folders
 * (its workers inherit the host's temp folder), and the media its turns showed (`TurnMedia`): each copy at its top
 * one thing, each page's folder one, its database kept.
 */
export function machineArtifactPlaces(roots: { artifacts: string; recordings: string; media: string }): ArtifactPlace[] {
  return [
    { kind: "recordings", root: roots.recordings, capBytes: 2 * GIB, entry: () => "one" },
    { kind: "artifacts", root: roots.artifacts, capBytes: 1 * GIB, entry: (_, folder) => (folder ? "files" : "one") },
    { kind: "media", root: roots.media, capBytes: 2 * GIB, entry: (name, folder) => (name.startsWith(MEDIA_DATABASE) ? "keep" : folder && name === PAGES_FOLDER ? "each" : "one") },
  ]
}

type Item = { path: string; bytes: number; newest: number }

export class MachineArtifacts {
  readonly #places: readonly ArtifactPlace[]
  readonly #graceMs: number
  readonly #now: () => number
  readonly #removed = new Map<ArtifactKind, { removed: number; removedBytes: number }>()
  #state: ArtifactCapState | undefined
  #sweeping: Promise<ArtifactCapState> | undefined

  constructor(options: { places: readonly ArtifactPlace[]; graceMs?: number; now?: () => number }) {
    this.#places = options.places
    this.#graceMs = options.graceMs ?? GRACE_MS
    this.#now = options.now ?? Date.now
  }

  /** Swept every few minutes as one of the host's jobs; the returned function stops it. */
  schedule(jobs: Pick<HostJobs, "every">): () => void {
    return jobs.every(ARTIFACTS_JOB, SWEEP_EVERY_MS, () => this.sweep().then(() => undefined), { firstAfterMs: FIRST_SWEEP_MS })
  }

  state(): ArtifactCapState | undefined {
    return this.#state
  }

  /** Each kind counted and held to its cap, oldest first; one sweep at a time. */
  sweep(): Promise<ArtifactCapState> {
    this.#sweeping ??= this.#sweep().finally(() => {
      this.#sweeping = undefined
    })
    return this.#sweeping
  }

  async #sweep(): Promise<ArtifactCapState> {
    const now = this.#now()
    const state: ArtifactCapState = { at: new Date(now).toISOString(), kinds: [] }
    if (this.#state?.lastRemoved) state.lastRemoved = this.#state.lastRemoved
    const failures: string[] = []
    // A place inside another (recordings under one task's artifacts) is counted as its own kind only.
    const roots = this.#places.map((place) => place.root)
    for (const place of this.#places) {
      const inner = roots.filter((root) => root !== place.root && root.startsWith(`${place.root}${sep}`))
      let items: Item[] = []
      try {
        items = await itemsOf(place, inner)
      } catch (error) {
        failures.push(`${place.kind}: ${errorMessage({ error })}`)
      }
      items.sort((a, b) => a.newest - b.newest)
      let bytes = items.reduce((sum, item) => sum + item.bytes, 0)
      let count = items.length
      const removed = this.#removed.get(place.kind) ?? { removed: 0, removedBytes: 0 }
      let freed = 0
      let freedItems = 0
      for (const item of items) {
        if (bytes <= place.capBytes) break
        const ageMs = now - item.newest
        if (ageMs < this.#graceMs) break
        try {
          await rm(item.path, { recursive: true, force: true })
        } catch (error) {
          failures.push(`${place.kind}: ${errorMessage({ error })}`)
          continue
        }
        bytes -= item.bytes
        count -= 1
        freed += item.bytes
        freedItems += 1
        state.lastRemoved = { at: state.at, kind: place.kind, path: relative(place.root, item.path), bytes: item.bytes, ageMs }
      }
      removed.removed += freedItems
      removed.removedBytes += freed
      this.#removed.set(place.kind, removed)
      if (freedItems) hostLog("machine", "recordings and artifacts over their cap; the oldest removed", { kind: place.kind, removed: freedItems, freedMB: mb(freed), keptMB: mb(bytes), capMB: mb(place.capBytes), kept: count })
      else if (bytes > place.capBytes) hostWarn("machine", "recordings and artifacts are over their cap, all of them still in use", { kind: place.kind, keptMB: mb(bytes), capMB: mb(place.capBytes), graceMinutes: Math.round(this.#graceMs / 60_000) })
      state.kinds.push({ kind: place.kind, bytes, items: count, capBytes: place.capBytes, ...removed })
    }
    if (failures.length) {
      state.failing = failures.join("; ").slice(0, 500)
      if (state.failing !== this.#state?.failing) hostWarn("machine", "recordings and artifacts couldn't all be counted or removed", { error: state.failing })
    }
    this.#state = state
    return state
  }
}

/** What's in a place, by its layout; nothing when it isn't there yet. Links are counted as themselves, never followed. */
async function itemsOf(place: ArtifactPlace, inner: readonly string[]): Promise<Item[]> {
  const entries = await readdir(place.root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  const items: Item[] = []
  for (const entry of entries) {
    const path = join(place.root, entry.name)
    if (inner.includes(path)) continue
    const unit = place.entry(entry.name, entry.isDirectory())
    if (unit === "keep") continue
    if (unit === "files" && entry.isDirectory()) {
      for await (const file of files(path, inner)) items.push(file)
      continue
    }
    if (unit === "each" && entry.isDirectory()) {
      for (const each of await readdir(path).catch(() => [])) {
        const measured = await measure(join(path, each), inner)
        if (measured) items.push({ path: join(path, each), ...measured })
      }
      continue
    }
    const measured = await measure(path, inner)
    if (measured) items.push({ path, ...measured })
  }
  return items
}

/** A file's size and time, or a folder's: every file in it added, its time the newest. Gone meanwhile: undefined. */
async function measure(path: string, inner: readonly string[]): Promise<{ bytes: number; newest: number } | undefined> {
  const stats = await lstat(path).catch(() => undefined)
  if (!stats) return undefined
  if (!stats.isDirectory()) return { bytes: stats.size, newest: stats.mtimeMs }
  let bytes = 0
  let newest = stats.mtimeMs
  for await (const file of files(path, inner)) {
    bytes += file.bytes
    newest = Math.max(newest, file.newest)
  }
  return { bytes, newest }
}

async function* files(folder: string, inner: readonly string[]): AsyncGenerator<Item> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = join(folder, entry.name)
    if (inner.includes(path)) continue
    if (entry.isDirectory()) {
      yield* files(path, inner)
      continue
    }
    const stats = await lstat(path).catch(() => undefined)
    if (stats) yield { path, bytes: stats.size, newest: stats.mtimeMs }
  }
}

function mb(bytes: number): number {
  return Math.round(bytes / 1_048_576)
}
