import parcel, { type AsyncSubscription } from "@parcel/watcher"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CanaryTestSchema, HistoryMarkSchema, WatcherRequestSchema, type CanaryTest, type HistoryMark, type WatcherReply } from "./contracts/watcher-child.js"

/*
 * @parcel/watcher's FSEvents backend races its own callback thread on
 * unsubscribe and when a watched root is deleted (still so in 2.6.0), which
 * corrupts the heap of whatever process hosts it. It runs here so that a
 * crash costs a restart of this child, not the app.
 */

const subscriptions = new Map<number, Promise<AsyncSubscription | undefined>>()
/** Subscriptions still settling: a first inotify crawl holds parcel's lock, so the canary waits. */
const settling = new Set<number>()

function reply(message: WatcherReply): void {
  if (process.connected) process.send?.(message)
}

process.on("message", (raw) => {
  const request = WatcherRequestSchema.safeParse(raw)
  if (!request.success) return
  const { id } = request.data
  if (request.data.t === "mark" || request.data.t === "since") {
    const asked = request.data
    void (asked.t === "mark" ? mark(id) : since(id, asked.mark, asked.roots)).catch((error: unknown) =>
      reply({ t: "failed", id, message: error instanceof Error ? error.message : String(error) }))
    return
  }
  if (request.data.t === "unsub") {
    const subscription = subscriptions.get(id)
    subscriptions.delete(id)
    settling.delete(id)
    void subscription?.then((current) => current?.unsubscribe()).catch(() => {})
    if (!subscriptions.size) stopCanary()
    return
  }
  settling.add(id)
  const subscription = parcel
    .subscribe(request.data.root, (error, events) => {
      if (!subscriptions.has(id)) return
      if (error) reply({ t: "dropped", id })
      else if (events.length) reply({ t: "events", id, events: events.map(({ path, type }) => ({ path, type })) })
    }, { ignore: request.data.ignore })
    .then((current) => {
      settling.delete(id)
      if (subscriptions.has(id)) {
        reply({ t: "ready", id })
        startCanary()
      }
      return current
    }, (error: Error) => {
      settling.delete(id)
      subscriptions.delete(id)
      reply({ t: "failed", id, message: error.message })
      if (!subscriptions.size) stopCanary()
      return undefined
    })
  subscriptions.set(id, subscription)
})

/*
 * The file system's history, read through parcel's snapshots. On FSEvents a
 * snapshot is only an event id and a time, the same for every root, so one
 * mark serves them all. Other backends' snapshots crawl the whole tree, so
 * history is FSEvents only. Roots are read one at a time: parcel's FSEvents
 * backend holds one lock across a read, and reads in parallel took seconds
 * where one after another took milliseconds.
 */
function snapshotFile(): string {
  return join(tmpdir(), `mako-history-${process.pid}-${Math.random().toString(36).slice(2)}`)
}

async function mark(id: number): Promise<void> {
  if (process.platform !== "darwin") throw new Error("The file system's history is read through FSEvents, on macOS only.")
  const file = snapshotFile()
  try {
    await parcel.writeSnapshot(tmpdir(), file, { backend: "fs-events" })
    const [eventId, at] = readFileSync(file, "utf8").trim().split(/\s+/)
    reply({ t: "marked", id, mark: HistoryMarkSchema.parse({ id: eventId, at }) })
  } finally {
    rmSync(file, { force: true })
  }
}

async function since(id: number, from: HistoryMark, roots: string[]): Promise<void> {
  if (process.platform !== "darwin") throw new Error("The file system's history is read through FSEvents, on macOS only.")
  const file = snapshotFile()
  writeFileSync(file, `${from.id}\n${from.at}`)
  const paths = new Set<string>()
  const lost: string[] = []
  try {
    for (const root of roots) {
      if (!existsSync(root)) continue
      try {
        for (const event of await parcel.getEventsSince(root, file, { backend: "fs-events" })) paths.add(event.path)
      } catch {
        lost.push(root)
      }
    }
  } finally {
    rmSync(file, { force: true })
  }
  reply({ t: "history", id, paths: [...paths], lost })
}

/*
 * A subscription that settles says nothing about delivery. An fseventsd
 * grown to gigabytes accepts every stream and delivers to none, and
 * parcel's one debounce thread can deadlock with the same result: no error,
 * just silence. So while anything is watched, this child watches a folder
 * of its own and writes to it. Missing that twice running means nothing
 * here is being heard; the host restarts the child once and polls until the
 * canary is heard again.
 */
const test = canaryTest()
const CANARY_EVERY_MS = test?.everyMs ?? 10_000
const CANARY_WITHIN_MS = test?.withinMs ?? 5_000
const CANARY_MISSES = 2
/** Beats skipped for a settling subscription before the wait is itself a stall. */
const SETTLE_BEATS = 12

interface Canary {
  folder: string
  subscription: Promise<AsyncSubscription | undefined>
  timer?: NodeJS.Timeout
  heard: number
  misses: number
  waited: number
  delivering?: boolean
}

let canary: Canary | undefined

function startCanary(): void {
  if (canary) return
  let folder: string
  try {
    folder = mkdtempSync(join(tmpdir(), "mako-watch-canary-"))
  } catch {
    return
  }
  const current: Canary = { folder, heard: 0, misses: 0, waited: 0, subscription: Promise.resolve(undefined) }
  canary = current
  current.subscription = parcel
    .subscribe(folder, (error, events) => {
      if (!error && events.length && !(test?.deafWhile && existsSync(test.deafWhile))) current.heard = Date.now()
    })
    .then((subscription) => {
      if (canary === current) beat(current)
      return subscription
    }, () => {
      if (canary === current) stopCanary()
      return undefined
    })
  // A subscribe that never settles is the stall itself: beats start regardless.
  current.timer = setInterval(() => beat(current), CANARY_EVERY_MS)
}

function beat(current: Canary): void {
  if (canary !== current) return
  if (settling.size && current.waited < SETTLE_BEATS) {
    current.waited += 1
    return
  }
  current.waited = 0
  const sent = Date.now()
  try {
    writeFileSync(join(current.folder, "beat"), String(sent))
  } catch {
    return
  }
  setTimeout(() => {
    if (canary !== current) return
    if (current.heard >= sent) {
      current.misses = 0
      report(current, true)
    } else if (++current.misses >= CANARY_MISSES) report(current, false)
  }, CANARY_WITHIN_MS)
}

function report(current: Canary, ok: boolean): void {
  if (current.delivering === ok) return
  current.delivering = ok
  reply({ t: "delivery", ok })
}

function stopCanary(): void {
  const current = canary
  if (!current) return
  canary = undefined
  clearInterval(current.timer)
  void current.subscription.then((subscription) => subscription?.unsubscribe()).catch(() => {}).finally(() => {
    rmSync(current.folder, { recursive: true, force: true })
  })
}

/** Tests shorten the beat and make the canary deaf while a file exists. */
function canaryTest(): CanaryTest | undefined {
  const raw = process.env.MAKO_WATCHER_CANARY_TEST
  if (!raw) return undefined
  try {
    return CanaryTestSchema.parse(JSON.parse(raw))
  } catch {
    return undefined
  }
}

process.on("exit", () => {
  if (canary) rmSync(canary.folder, { recursive: true, force: true })
})

// The host is gone, or let this child go: nothing here outlives it.
process.on("disconnect", () => process.exit(0))
