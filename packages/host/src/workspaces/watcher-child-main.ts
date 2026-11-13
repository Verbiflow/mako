import parcel, { type AsyncSubscription } from "@parcel/watcher"
import { execFile, type ChildProcess } from "node:child_process"
import { z } from "zod"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { OTHER_APPS_DATA } from "../base/other-apps-data.js"
import { membersOnly, parseTable, PS_ARGS, type RunLeader } from "./process-table.js"
import { CanaryTestSchema, HISTORY_SCRATCH, HistoryMarkSchema, MAX_EXCLUDED, WatcherRequestSchema, type CanaryTest, type DropReason, type HistoryMark, type WatcherReply, type WatcherRequest } from "../contracts/watcher-child.js"

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
  if (request.data.t === "run") {
    runProbe(request.data)
    return
  }
  if (request.data.t === "cancel") {
    probes.get(id)?.kill()
    return
  }
  if (request.data.t === "table" || request.data.t === "members") {
    const asked = request.data
    void (asked.t === "table" ? readTable().then((text) => reply({ t: "table", id, text })) : readMembers(id, asked.runs, asked.self))
      .catch((error) => reply({ t: "failed", id, message: error instanceof Error ? error.message : String(error) }))
    return
  }
  if (request.data.t === "mark" || request.data.t === "since" || request.data.t === "probe") {
    const asked = request.data
    void (asked.t === "mark" ? mark(id) : asked.t === "probe" ? probe(id, asked.beats) : since(id, asked.mark, asked.roots, asked.ignore, asked.exclude ?? [], asked.perFolder)).catch((error) =>
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
      if (error) {
        const reason = dropReason(error)
        reply({ t: "dropped", id, ...(reason && { reason }) })
      }
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

/** Who dropped events, from parcel's messages for FSEvents' rescan flags; other backends' errors say nothing. */
function dropReason(error: Error): DropReason | undefined {
  if (error.message.includes("by the FSEvents client")) return "client"
  if (error.message.includes("by the kernel")) return "kernel"
  if (error.message.startsWith("Too many events")) return "coalesced"
  return undefined
}

/*
 * The file system's history, read through parcel's snapshots. On FSEvents a
 * snapshot is only an event id and a time, the same for every root, so one
 * mark serves them all. Other backends' snapshots crawl the whole tree, so
 * history is FSEvents only. Roots are read one at a time: parcel's FSEvents
 * backend holds one lock across a read, and reads in parallel took seconds
 * where one after another took milliseconds.
 */
function snapshotFile(): string {
  // In a folder of their own, which footprints leave out as Mako's: the temporary folder is a footprint root.
  const folder = join(tmpdir(), HISTORY_SCRATCH)
  mkdirSync(folder, { recursive: true })
  return join(folder, `${process.pid}-${Math.random().toString(36).slice(2)}`)
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

/**
 * How long a read waiting for its sentinel first waits before replaying the
 * scratch folder again, doubling to `CAUGHT_UP_POLL_MAX_MS`. Each replay is a
 * stream fseventsd registers and answers: at a steady 20 ms, a daemon 2.6 s
 * behind was asked 130 times for every read.
 */
const CAUGHT_UP_POLL_MS = 20
const CAUGHT_UP_POLL_MAX_MS = 500

/*
 * FSEvents replays its history only up to the newest id it has committed
 * (FSEventsGetCurrentEventId), and that runs behind the events it has
 * already handed out live: by milliseconds healthy, by seconds on a
 * degraded fseventsd. A change made just
 * before a read can be past the history and yet before a new stream
 * started, so neither the replay nor that stream ever reports it. The ids
 * follow the order changes happen in, so a read first writes a sentinel and
 * waits until a replay of the scratch folder holds it: every change made
 * before the read is in the history from then on. The sentinel is on the
 * temporary folder's volume, where checkouts usually are too. Resolves
 * false when the history dropped events on the way, so a read can't be
 * sure of being complete; a sentinel that never shows is a stuck history,
 * which the host ends by its own deadline.
 */
async function caughtUp(): Promise<boolean> {
  const mark = snapshotFile()
  const sentinel = snapshotFile()
  // The history reports real paths: /private/var, not /var.
  const folder = realpathSync(dirname(sentinel))
  const reported = join(folder, basename(sentinel))
  try {
    await parcel.writeSnapshot(folder, mark, { backend: "fs-events" })
    writeFileSync(sentinel, "")
    for (let wait = CAUGHT_UP_POLL_MS; !(await parcel.getEventsSince(folder, mark, { backend: "fs-events" })).some((event) => event.path === reported); wait = Math.min(wait * 2, CAUGHT_UP_POLL_MAX_MS))
      await new Promise((resolve) => setTimeout(resolve, wait))
    return true
  } catch {
    return false
  } finally {
    rmSync(sentinel, { force: true })
    rmSync(mark, { force: true })
  }
}

async function since(id: number, from: HistoryMark, roots: string[], ignore: readonly string[], exclude: readonly string[], perFolder?: number): Promise<void> {
  if (process.platform !== "darwin") throw new Error("The file system's history is read through FSEvents, on macOS only.")
  const started = performance.now()
  const complete = await caughtUp()
  const caughtUpMs = performance.now() - started
  const file = snapshotFile()
  writeFileSync(file, `${from.id}\n${from.at}`)
  const paths = new Set<string>()
  const lost: string[] = []
  const folders = new Map(ignore.map((folder, index) => [folder, index]))
  const ignored = ignore.map(() => 0)
  // Sent per folder one level into its root, so a busy day's 345,000 changed paths (2026-11-12) aren't all sent to be
  // parsed and walked on the host's thread for a trace that keeps a few of each folder's.
  const sent = new Map<string, number>()
  const capped = new Set<string>()
  let unsent = 0
  try {
    for (const root of roots) {
      if (!existsSync(root)) continue
      // Only folders inside the root: excluding one that holds it would leave the whole read out.
      // Other apps' containers first, always: replaying a change, the watcher stats the path unless it's left out here,
      // and a stat in another app's container from Mako's child makes macOS ask the person to let Mako read that app's data.
      const sealed = OTHER_APPS_DATA.map((folder) => join(homedir(), folder)).filter((folder) => folder.startsWith(`${root}/`))
      const excluded = [...sealed, ...exclude.filter((folder) => folder.startsWith(`${root}/`) && !sealed.includes(folder))].slice(0, MAX_EXCLUDED)
      try {
        for (const event of await parcel.getEventsSince(root, file, { backend: "fs-events", ignore: excluded })) {
          if (paths.has(event.path)) continue
          const at = folders.size ? ignoredBy(folders, event.path) : -1
          if (at >= 0) ignored[at]! += 1
          else if (perFolder === undefined) paths.add(event.path)
          else {
            // A folder itself, or a path outside every folder, is always sent; past `perFolder`, a folder's are counted.
            const folder = folderIn(root, event.path)
            if (folder !== undefined && folder !== event.path) {
              const count = sent.get(folder) ?? 0
              if (count >= perFolder) {
                capped.add(folder)
                unsent += 1
                continue
              }
              sent.set(folder, count + 1)
            }
            paths.add(event.path)
          }
        }
        if (!complete) lost.push(root)
      } catch {
        lost.push(root)
      }
    }
  } finally {
    rmSync(file, { force: true })
  }
  reply({ t: "history", id, paths: [...paths], lost, ignored, caughtUpMs, readMs: performance.now() - started - caughtUpMs, ...(perFolder !== undefined && { capped: [...capped], unsent }) })
}

/** The folder one level into `root` that holds `path`; undefined for the root itself or a path outside it. */
function folderIn(root: string, path: string): string | undefined {
  if (!path.startsWith(`${root}/`)) return undefined
  const end = path.indexOf("/", root.length + 1)
  return end < 0 ? path : path.slice(0, end)
}

/**
 * The innermost `ignore` folder holding `path`, or -1: one map lookup per
 * folder on its way up, so a history of 70,000 paths against hundreds of
 * folders costs a few milliseconds here, not a trip across to the host.
 */
function ignoredBy(folders: ReadonlyMap<string, number>, path: string): number {
  for (let end = path.length; end > 0; end = path.lastIndexOf("/", end - 1)) {
    const at = folders.get(end === path.length ? path : path.slice(0, end))
    if (at !== undefined) return at
  }
  return -1
}

/** How long a probe waits for each of its beats. */
const PROBE_WITHIN_MS = 10_000
/** Between a probe's beats, so parcel's debounce never folds two into one. */
const PROBE_GAP_MS = 100

/**
 * Delivery measured now: a folder of this probe's own, written `beats`
 * times, one after another, each timed until its own path is heard. Taken
 * after fseventsd restarts, so the person sees how late events are then
 * without waiting a minute of the canary's beats.
 */
async function probe(id: number, beats: number): Promise<void> {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "mako-watch-probe-")))
  const heard = new Map<string, () => void>()
  const lagsMs: number[] = []
  let subscription: AsyncSubscription | undefined
  try {
    subscription = await parcel.subscribe(folder, (error, events) => {
      if (error) return
      for (const event of events) {
        const hear = heard.get(event.path)
        if (!hear) continue
        heard.delete(event.path)
        if (test?.lagMs) setTimeout(hear, test.lagMs)
        else hear()
      }
    })
    for (let index = 0; index < beats; index++) {
      const path = join(folder, `beat-${index}`)
      const sent = performance.now()
      const lag = await new Promise<number | undefined>((settle) => {
        const timer = setTimeout(() => settle(undefined), PROBE_WITHIN_MS)
        heard.set(path, () => {
          clearTimeout(timer)
          settle(performance.now() - sent)
        })
        writeFileSync(path, String(Date.now()))
      })
      heard.delete(path)
      if (lag !== undefined) lagsMs.push(Math.round(lag))
      await new Promise((resolve) => setTimeout(resolve, PROBE_GAP_MS))
    }
  } finally {
    await subscription?.unsubscribe().catch(() => {})
    rmSync(folder, { recursive: true, force: true })
  }
  reply({ t: "probed", id, lagsMs })
}

/*
 * A subscription that settles says nothing about delivery. A degraded
 * fseventsd, grown to gigabytes, accepts every stream and delivers to none,
 * and parcel's one debounce thread can deadlock with the same result: no
 * error, just silence. So while anything is watched, this child watches a
 * folder of its own and writes to it. Missing that twice running means
 * nothing here is being heard; the host restarts the child once and polls
 * until the canary is heard again.
 *
 * Late is not silent: a degraded fseventsd delivers in batches, seconds
 * apart, with nothing lost, and each silence costs every root a poll and a
 * rescan and the child a restart. A beat is missed only when nothing is
 * heard for `CANARY_WITHIN_MS`. How late each beat arrives goes to the host
 * (`beat`), which reads the daemon's health from it and offers the restart
 * that fixes a degraded one; the slowest of the latest is said as `delivery`.
 */
const test = canaryTest()
const CANARY_EVERY_MS = test?.everyMs ?? 10_000
const CANARY_WITHIN_MS = test?.withinMs ?? 30_000
const CANARY_MISSES = 2
/** Beats skipped for a settling subscription before the wait is itself a stall. */
const SETTLE_BEATS = 12
/** How many of the latest beats' lags the reported one is the slowest of. */
const LAGS_KEPT = 6
/** The lag is said again once it moves this far from what was said. */
const LAG_STEP_MS = 1_000

interface Canary {
  folder: string
  subscription: Promise<AsyncSubscription | undefined>
  timer?: NodeJS.Timeout
  heard: number
  misses: number
  waited: number
  delivering?: boolean
  /** When the oldest beat not yet heard was written. */
  unheardSince?: number
  /** How late the latest beats were heard, oldest first. */
  lags: number[]
  /** The lag last reported. */
  reported?: number
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
  const current: Canary = { folder, heard: 0, misses: 0, waited: 0, lags: [], subscription: Promise.resolve(undefined) }
  canary = current
  current.subscription = parcel
    .subscribe(folder, (error, events) => {
      if (error || !events.length || (test?.deafWhile && existsSync(test.deafWhile))) return
      if (test?.lagMs) setTimeout(() => heard(current), test.lagMs)
      else heard(current)
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
  current.unheardSince ??= sent
  setTimeout(() => {
    if (canary !== current) return
    if (current.heard >= sent) {
      current.misses = 0
      report(current, true)
    } else if (++current.misses >= CANARY_MISSES) report(current, false)
  }, CANARY_WITHIN_MS)
}

/** A beat arrived: how late the oldest one waiting was, kept, and said when the slowest kept moves a step either way. */
function heard(current: Canary): void {
  if (canary !== current) return
  const now = Date.now()
  current.heard = now
  if (current.unheardSince === undefined) return
  const lag = now - current.unheardSince
  current.lags.push(lag)
  current.unheardSince = undefined
  reply({ t: "beat", lagMs: lag })
  if (current.lags.length > LAGS_KEPT) current.lags.shift()
  const lagMs = Math.max(...current.lags)
  if (current.reported !== undefined && Math.abs(lagMs - current.reported) < LAG_STEP_MS) return
  current.reported = lagMs
  // While unheard, the beat that ends it reports the lag along with delivery.
  if (current.delivering !== false) reply({ t: "delivery", ok: true, lagMs })
}

function report(current: Canary, ok: boolean): void {
  if (current.delivering === ok) return
  current.delivering = ok
  reply({ t: "delivery", ok, ...(ok && current.lags.length && { lagMs: Math.max(...current.lags) }) })
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

/** Tests shorten the beat, make the canary deaf while a file exists, and delay what it and a probe hear. */
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

/** At most this much of `ps`'s output, as the host's own read allows. */
const TABLE_BYTES = 16 * 1024 * 1024
/** A `ps` this slow is stuck; the host reads its own table instead. */
const TABLE_MS = 15_000

/** The process table as `ps` prints it: one `ps` per ask, in this child's process group, ended with it. */
function readTable(): Promise<string> {
  return new Promise<string>((done, fail) => {
    execFile("ps", [...PS_ARGS], { env: { ...process.env, LC_ALL: "C" }, maxBuffer: TABLE_BYTES, timeout: TABLE_MS }, (error, stdout) => {
      if (error) fail(error)
      else done(stdout)
    })
  })
}

/** Programs a probe may run: they only read the machine. The host asks only for these (`isProbe`). */
const PROBE_PROGRAMS = new Set(["ps", "pgrep", "lsof", "sysctl", "footprint", "vm_stat", "pmset", "notifyutil", "nice"])
/** Probes under way, by the host's id, so a `cancel` ends one. */
const probes = new Map<number, ChildProcess>()

/** A probe, answered whatever becomes of it: its output, its exit, and why it failed when it did. */
function runProbe(asked: Extract<WatcherRequest, { t: "run" }>): void {
  const { id, file, args } = asked
  const program = basename(file)
  const lowered = program === "nice" ? basename(args[2] ?? "") : program
  if (!PROBE_PROGRAMS.has(program) || lowered === "nice" || !PROBE_PROGRAMS.has(lowered)) {
    reply({ t: "failed", id, message: `Not a probe: ${file}` })
    return
  }
  const child = execFile(file, args, { env: asked.env ?? process.env, cwd: asked.cwd, timeout: asked.timeout ?? 0, maxBuffer: asked.maxBuffer ?? 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
    probes.delete(id)
    // An exit code is a number; a string code (ENOENT, the output past its limit) is a failure to run.
    const exited = z.number().int().safeParse(error?.code)
    const named = z.string().safeParse(error?.code)
    const exit = !error ? 0 : exited.success ? exited.data : null
    const failure = error && exit === null ? { message: error.message, ...(named.success && { code: named.data }) } : undefined
    reply({ t: "ran", id, stdout, stderr, code: exit, signal: error?.signal ?? null, killed: Boolean(error?.killed), ...(failure && { failure }) })
  })
  probes.set(id, child)
}

/** Only `runs`' processes of the table, parsed and matched here, off the host's loop. */
async function readMembers(id: number, runs: RunLeader[], self: number): Promise<void> {
  reply({ t: "members", id, rows: membersOnly(parseTable(await readTable()), runs, self) })
}
