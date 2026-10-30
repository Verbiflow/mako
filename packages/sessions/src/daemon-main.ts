/**
 * The daemon's entry point: `node dist/daemon-main.js`.
 *
 * Also happy under `ELECTRON_RUN_AS_NODE=1 <electron> dist/daemon-main.js`,
 * which is how the desktop app launches it — the app ships a Node runtime
 * already, and shipping a second one to run forty lines would be absurd.
 *
 * Keeps its cache in Mako's state directory and exits quietly if a daemon
 * is already serving —
 * every launcher can "start the daemon" unconditionally and exactly one
 * survives.
 *
 * An on-demand reader (`--on-demand`) exits 1 when it can't serve, so the
 * host that started it stops waiting; leaving for another reader is exit 0.
 * The login daemon always exits 0: launchd restarts it on any other exit,
 * which would retry a failure that can't pass every ten seconds.
 *
 * The record store's backfill (`--backfill`) runs in a process of its own,
 * which the serving daemon starts once discovery is in and every ten minutes
 * after, one at a time, at the lowest CPU priority: a first capture of a
 * large database session holds far more than the login daemon's 128 MB heap
 * (246 MB for a 343k-row Cursor store, `npm run bench:backfill`), and a pass
 * that ends gives its memory back. Before, a host whose rail this daemon
 * served never took the sessions written before it into the record store.
 *
 * Every process here keeps `~/.mako/logs/syncd.log` (`process-log.ts`, the
 * host log's format and bound): its start, each client, why it retires or
 * exits, each backfill pass's process, and what it prints. Its stdio is
 * ignored by whoever spawned it, and once it restarted every 20 to 60 s with
 * no trace of why. A fatal error V8 or Node can't hand to JavaScript (out of
 * memory) leaves a diagnostic report in `~/.mako/logs/syncd-reports`.
 */

import { makoRuntimeReadings } from "./record-observed.js"
import { spawn } from "node:child_process"
import { mkdirSync, readdirSync, rmSync } from "node:fs"
import { chmod, mkdir } from "node:fs/promises"
import { constants, homedir, setPriority } from "node:os"
import { join } from "node:path"
import type { Server } from "node:net"
import { format } from "node:util"
import { getHeapStatistics } from "node:v8"
import { openProcessLog, syncdLogPath, syncdReportsPath, type LogFields, type LogLevel, type ProcessLog } from "./process-log.js"
import { defaultCatalog, defaultCatalogIdentity, loadedCatalogCode } from "./index.js"
import { onDemandCatalogPaths } from "./catalog-identity.js"
import { makoRecords } from "./record-streams.js"
import { makoViews } from "./view-cache.js"
import { WorkUnderWay } from "./loop-watch.js"
import {
  claimDaemon,
  DaemonAlreadyServing,
  daemonSocketPath,
  serveCatalog,
  type DaemonClaim,
} from "./daemon.js"

const MB = 1024 * 1024
/** Fatal-error reports kept: each is a few hundred KB, and the newest say what killed the reader. */
const REPORTS_KEPT = 5
/** A memory line is written at most once a minute, and only when RSS moved this far since the last. */
const MEMORY_STEP_BYTES = 64 * MB

/** This process's log line writer: the file, and what it prints for whoever runs it by hand. */
let log: ProcessLog | null = null
let scope = "syncd"
/** Why this process is about to end, said once by the `exit` line. */
let exitReason: string | undefined

function say(level: LogLevel, message: string, fields?: LogFields): void {
  log?.write(level, scope, message, fields)
}

/**
 * Open the log, keep what the console prints in it, write the exit line however the process ends, and leave a
 * diagnostic report when V8 or Node aborts it. A crash (an uncaught exception, an unhandled rejection) still crashes;
 * it is only written down first, synchronously, because nothing awaited runs after.
 */
function installLog(dir: string, role: string): void {
  const opened = openProcessLog(syncdLogPath(dir))
  log = opened
  scope = role === "backfill" ? "backfill" : "syncd"
  for (const [method, level] of [["log", "info"], ["warn", "warn"], ["error", "error"]] as const) {
    const print = console[method]
    console[method] = (...args: unknown[]) => {
      print.apply(console, args)
      opened.write(level, scope, format(...args))
    }
  }
  process.on("uncaughtExceptionMonitor", (error, origin) => {
    exitReason = origin === "unhandledRejection" ? "unhandled rejection" : "uncaught exception"
    opened.writeNow("error", scope, exitReason, { error: error instanceof Error ? error.stack ?? error.message : String(error) })
  })
  process.on("exit", (code) => {
    opened.writeNow(code === 0 ? "info" : "error", scope, "exited", { pid: process.pid, code, reason: exitReason ?? "nothing left to do" })
  })
  try {
    const reports = syncdReportsPath(dir)
    mkdirSync(reports, { recursive: true })
    const kept = readdirSync(reports).filter((name) => name.endsWith(".json")).sort()
    for (const name of kept.slice(0, Math.max(0, kept.length - REPORTS_KEPT))) rmSync(join(reports, name), { force: true })
    process.report.directory = reports
    process.report.reportOnFatalError = true
    process.report.compact = true
    // A report that resolves every socket's peer can hang a dying process (as the host's, `crash.ts`).
    Object.assign(process.report, { excludeNetwork: true })
    const last = kept.at(-1)
    if (last) say("info", "a fatal-error report is kept", { report: join(reports, last) })
  } catch (error) {
    say("warn", "fatal-error reports are off", { error: error instanceof Error ? error.message : String(error) })
  }
}

/** A line once a minute while memory moves, so a reader the guard or V8 ends shows how it got there. */
function watchMemory(): void {
  let logged = 0
  const sample = () => {
    const { rss, heapUsed } = process.memoryUsage()
    if (logged && Math.abs(rss - logged) < MEMORY_STEP_BYTES) return
    logged = rss
    say("info", "memory", { rssMb: Math.round(rss / MB), heapUsedMb: Math.round(heapUsed / MB) })
  }
  sample()
  setInterval(sample, 60_000).unref()
}

/** Return transient scan capacity after a quiet beat; retained catalog data is tiny. */
function collectIdleHeap(): void {
  if (process.memoryUsage().heapTotal < 32 * 1024 * 1024) return
  void global.gc?.({ type: "major", flavor: "last-resort", execution: "async" })
}

/** A backfill pass's process starts this long after the last one ended, as the in-process backfill's passes do. */
const BACKFILL_EVERY_MS = 10 * 60_000
/** Its heap: the catalog worker's, which holds the largest first capture measured. */
const BACKFILL_HEAP_MB = 768

/** One backfill pass over every session in the rail, in this process, then out (`--backfill`). */
async function backfillOnce(dir: string): Promise<void> {
  const catalog = defaultCatalog({
    // Its own cache, so its scans never race the serving daemon's writes of its own.
    cachePath: join(dir, "syncd-backfill-catalog.json"),
    archivePath: join(dir, "archive"),
    recordsPath: makoRecords(),
    viewsPath: makoViews(),
    runtimeReadings: makoRuntimeReadings(),
    ...process.env.MAKO_STORE_WRITER && { writer: process.env.MAKO_STORE_WRITER },
    backfill: true,
    log: (message, fields) => say("info", message, fields),
  })
  try {
    await catalog.prepare()
    await catalog.scan()
    await catalog.backfillNow()
  } finally {
    await catalog.stop()
  }
}

/**
 * Starts a backfill pass's process now and every ten minutes after the last ended, never two at once; the returned
 * function stops starting them and ends the one running.
 */
function scheduleBackfill(work: WorkUnderWay): () => void {
  let child: ReturnType<typeof spawn> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const run = () => {
    if (stopped) return
    const script = process.argv[1]
    if (!script) return
    const pass = work.run("start a backfill pass", () => spawn(process.execPath, [`--max-old-space-size=${BACKFILL_HEAP_MB}`, script, "--backfill"], { stdio: "ignore", env: process.env }))
    child = pass
    const started = Date.now()
    say("info", "backfill pass started", { pid: pass.pid, heapMb: BACKFILL_HEAP_MB })
    // Below the agents and the person: Mako's own `belowAgents` priority.
    if (child.pid) {
      try {
        setPriority(child.pid, constants.priority.PRIORITY_LOW)
      } catch {
        // It exited already, or this platform won't lower it; the pass is the same either way.
      }
    }
    const ended = () => {
      child = undefined
      if (stopped) return
      timer = setTimeout(run, BACKFILL_EVERY_MS)
      timer.unref?.()
    }
    pass.once("exit", (code, signal) => {
      say(code === 0 ? "info" : "warn", "backfill pass ended", { pid: pass.pid, code, signal, ms: Date.now() - started })
      ended()
    })
    pass.once("error", (error) => {
      console.log(`mako-syncd: the backfill couldn't start: ${error.message}`)
      ended()
    })
  }
  run()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    child?.kill("SIGTERM")
  }
}

async function main(): Promise<void> {
  const loadedCode = loadedCatalogCode()
  // The title lets an installer tell this detached daemon from the app whose
  // executable it borrowed; the executable name is what would otherwise make
  // an update wait forever for it to "close". A backfill pass's process takes
  // it too, for the same reason.
  process.title = "mako-syncd"
  const dir = join(homedir(), ".mako")
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const backfill = process.argv.includes("--backfill")
  const onDemand = process.argv.includes("--on-demand")
  const role = backfill ? "backfill" : onDemand ? "on-demand" : "login"
  installLog(dir, role)
  say("info", "started", {
    pid: process.pid,
    ppid: process.ppid,
    role,
    // The build that launched it (`storeWriter`), and the LaunchAgent's when launchd did.
    build: process.env.MAKO_STORE_WRITER ?? process.env.MAKO_DAEMON_VERSION,
    node: process.version,
    heapLimitMb: Math.round(getHeapStatistics().heap_size_limit / MB),
  })
  if (backfill) {
    await backfillOnce(dir)
    exitReason = "the pass ended"
    return
  }
  watchMemory()
  const archivePath = join(dir, "archive")
  const identity = await defaultCatalogIdentity(archivePath, loadedCode)
  const paths = onDemand ? onDemandCatalogPaths(identity) : null
  const socketPath = paths?.socket ?? daemonSocketPath()
  say("info", "claiming", { socket: socketPath, identity, code: await loadedCode })
  let claim: DaemonClaim
  try {
    claim = await claimDaemon(socketPath)
  } catch (error) {
    exitReason = error instanceof DaemonAlreadyServing ? "another reader holds the claim" : "the claim failed"
    console.log(String(error instanceof Error ? error.message : error))
    if (onDemand && !(error instanceof DaemonAlreadyServing)) process.exitCode = 1
    return
  }

  // What this process does, by name, for the watch on its loop: a request answered late says why.
  const work = new WorkUnderWay()
  const catalog = defaultCatalog({
    work,
    cachePath: paths?.cache ?? join(dir, "syncd-catalog.json"),
    // Mako's copies of sessions nothing else holds any more, read as they were kept.
    archivePath,
    recordsPath: makoRecords(),
    viewsPath: makoViews(),
    runtimeReadings: makoRuntimeReadings(),
    // The build that launched it, so a store format it sets names that build (`storeWriter`).
    ...process.env.MAKO_STORE_WRITER && { writer: process.env.MAKO_STORE_WRITER },
    // No backfill in this process: a pass's own process runs it (`scheduleBackfill`).
  })

  const started = performance.now()
  let stopBackfill: (() => void) | undefined
  let server: Server
  try {
    await catalog.prepare()
    const discovery = catalog.scan().then((refs) => {
      catalog.startWatching()
      console.log(`mako-syncd: discovered ${refs.length} sessions in ${Math.round(performance.now() - started)}ms`)
      stopBackfill = scheduleBackfill(work)
      return refs
    })
    // Observe failures while socket ownership and identity are being resolved.
    void discovery.catch(() => {})
    server = await serveCatalog(catalog, socketPath, claim, {
      catalogIdentity: identity,
      discovery,
      idleMs: onDemand ? 10_000 : undefined,
      work,
      log: (level, message, fields) => {
        if (message === "retiring") exitReason = `retired: ${fields?.reason ?? "unknown"}`
        say(level, message, fields)
      },
    })
    // A daemon that retires, or whose discovery failed, ends the pass it started.
    server.once("close", () => stopBackfill?.())
    void discovery.catch((error) => {
      exitReason = "discovery failed"
      console.error("mako-syncd: discovery failed", error)
      server.close()
      void catalog.stop()
    })
    console.log(
      `mako-syncd: reader available in ${Math.round(performance.now() - started)}ms · ${socketPath}`
    )
  } catch (error) {
    exitReason = error instanceof DaemonAlreadyServing ? "another reader is serving" : "it could not serve"
    console.log(String(error instanceof Error ? error.message : error))
    if (onDemand && !(error instanceof DaemonAlreadyServing)) process.exitCode = 1
    catalog.stop()
    await claim.release()
    return
  }

  let collectionTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleCollection = () => {
    if (collectionTimer) clearTimeout(collectionTimer)
    collectionTimer = setTimeout(collectIdleHeap, 1_000)
    collectionTimer.unref?.()
  }
  const stopCollectionEvents = catalog.onEvent(scheduleCollection)
  const collectionFallback = setInterval(collectIdleHeap, 60_000)
  collectionFallback.unref?.()
  scheduleCollection()

  let stopping = false
  const stop = async (signal: NodeJS.Signals) => {
    if (stopping) return
    stopping = true
    exitReason = signal
    say("info", "stopping", { signal })
    if (collectionTimer) clearTimeout(collectionTimer)
    clearInterval(collectionFallback)
    stopCollectionEvents()
    stopBackfill?.()
    server.close()
    await catalog.stop()
    process.exit(0)
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}

void main()
