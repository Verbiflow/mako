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
 */

import { chmod, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Server } from "node:net"
import { defaultCatalog, defaultCatalogIdentity } from "./index.js"
import { onDemandCatalogPaths } from "./catalog-identity.js"
import {
  claimDaemon,
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
  // The title lets an installer tell this detached daemon from the app whose
  // executable it borrowed; the executable name is what would otherwise make
  // an update wait forever for it to "close".
  process.title = "mako-syncd"
  const dir = join(homedir(), ".mako")
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const onDemand = process.argv.includes("--on-demand")
  const archivePath = join(dir, "archive")
  const identity = await defaultCatalogIdentity(archivePath)
  const paths = onDemand ? onDemandCatalogPaths(identity) : null
  const socketPath = paths?.socket ?? daemonSocketPath()
  let claim: DaemonClaim
  try {
    claim = await claimDaemon(socketPath)
  } catch (error) {
    console.log(String(error instanceof Error ? error.message : error))
    return
  }

  const catalog = defaultCatalog({
    cachePath: paths?.cache ?? join(dir, "syncd-catalog.json"),
    // The daemon owns the durable copy: every session it ever sees is also
    // written here, and survives its native store being pruned or deleted.
    archivePath,
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
