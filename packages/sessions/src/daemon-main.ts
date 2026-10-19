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
 */

import { chmod, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
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

async function main(): Promise<void> {
  const loadedCode = loadedCatalogCode()
  // The title lets an installer tell this detached daemon from the app whose
  // executable it borrowed; the executable name is what would otherwise make
  // an update wait forever for it to "close".
  process.title = "mako-syncd"
  const dir = join(homedir(), ".mako")
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
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
    // The build that launched it, so a store format it sets names that build (`storeWriter`).
    ...process.env.MAKO_STORE_WRITER && { writer: process.env.MAKO_STORE_WRITER },
    // No backfill here: a first capture of a large database session holds far more than this
    // process's 128 MB heap (246 MB for a 343k-row Cursor store, `npm run bench:backfill`).
    // The catalog worker, in its 768 MB heap, runs it.
  })

  const started = performance.now()
  let server: Server
  try {
    await catalog.prepare()
    const discovery = catalog.scan().then((refs) => {
      catalog.startWatching()
      console.log(`mako-syncd: discovered ${refs.length} sessions in ${Math.round(performance.now() - started)}ms`)
      return refs
    })
    // Observe failures while socket ownership and identity are being resolved.
    void discovery.catch(() => {})
    server = await serveCatalog(catalog, socketPath, claim, {
      catalogIdentity: identity,
      discovery,
      idleMs: onDemand ? 10_000 : undefined,
    })
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
    server.close()
    await catalog.stop()
    process.exit(0)
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}

void main()
