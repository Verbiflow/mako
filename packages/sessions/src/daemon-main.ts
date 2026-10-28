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
 */

import { makoRuntimeReadings } from "./record-observed.js"
import { spawn } from "node:child_process"
import { chmod, mkdir } from "node:fs/promises"
import { constants, homedir, setPriority } from "node:os"
import { join } from "node:path"
import type { Server } from "node:net"
import { defaultCatalog, defaultCatalogIdentity, loadedCatalogCode } from "./index.js"
import { onDemandCatalogPaths } from "./catalog-identity.js"
import { makoRecords } from "./record-streams.js"
import { makoViews } from "./view-cache.js"
import {
  claimDaemon,
  DaemonAlreadyServing,
  daemonSocketPath,
  serveCatalog,
  type DaemonClaim,
} from "./daemon.js"

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
    log: (message, fields) => console.log(message, JSON.stringify(fields)),
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
function scheduleBackfill(): () => void {
  let child: ReturnType<typeof spawn> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const run = () => {
    if (stopped) return
    const script = process.argv[1]
    if (!script) return
    child = spawn(process.execPath, [`--max-old-space-size=${BACKFILL_HEAP_MB}`, script, "--backfill"], { stdio: "ignore", env: process.env })
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
    child.once("exit", ended)
    child.once("error", (error) => {
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
  if (process.argv.includes("--backfill")) {
    await backfillOnce(dir)
    return
  }
  const onDemand = process.argv.includes("--on-demand")
  const archivePath = join(dir, "archive")
  const identity = await defaultCatalogIdentity(archivePath, loadedCode)
  const paths = onDemand ? onDemandCatalogPaths(identity) : null
  const socketPath = paths?.socket ?? daemonSocketPath()
  let claim: DaemonClaim
  try {
    claim = await claimDaemon(socketPath)
  } catch (error) {
    console.log(String(error instanceof Error ? error.message : error))
    if (onDemand && !(error instanceof DaemonAlreadyServing)) process.exitCode = 1
    return
  }

  const catalog = defaultCatalog({
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
      stopBackfill = scheduleBackfill()
      return refs
    })
    // Observe failures while socket ownership and identity are being resolved.
    void discovery.catch(() => {})
    server = await serveCatalog(catalog, socketPath, claim, {
      catalogIdentity: identity,
      discovery,
      idleMs: onDemand ? 10_000 : undefined,
    })
    // A daemon that retires, or whose discovery failed, ends the pass it started.
    server.once("close", () => stopBackfill?.())
    void discovery.catch((error) => {
      console.error("mako-syncd: discovery failed", error)
      server.close()
      void catalog.stop()
    })
    console.log(
      `mako-syncd: reader available in ${Math.round(performance.now() - started)}ms · ${socketPath}`
    )
  } catch (error) {
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
  const stop = async () => {
    if (stopping) return
    stopping = true
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
