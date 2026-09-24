import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { connectDaemon, defaultCatalogIdentity, onDemandCatalogPaths, type DaemonClient } from "@mako/sessions"
import { daemonScript } from "./daemon-login.js"
import { daemonIsForeign } from "./daemon-vintage.js"
import { ON_DEMAND_CATALOG_NODE_ARGS } from "./daemon-command.js"
import { headlessNodeExecutable } from "./headless-node.js"

/** Join a compatible on-demand reader. Its own claim arbitrates simultaneous starts. */
export async function connectOnDemandCatalog(signal: AbortSignal): Promise<DaemonClient | null> {
  const identity = await defaultCatalogIdentity(join(homedir(), ".mako", "archive"))
  signal.throwIfAborted()
  const { socket } = onDemandCatalogPaths(identity)
  const connect = async () => {
    const client = await connectDaemon(socket, 500).catch(() => null)
    if (!client) return null
    if (signal.aborted || daemonIsForeign(client.stats, daemonScript(), identity)) {
      client.close()
      signal.throwIfAborted()
      return null
    }
    return client
  }
  const existing = await connect()
  if (existing) return existing
  signal.throwIfAborted()
  const child = spawn(headlessNodeExecutable(), [...ON_DEMAND_CATALOG_NODE_ARGS, daemonScript(), "--on-demand"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  })
  let failed = false
  child.once("error", () => { failed = true })
  child.unref()
  // Do not kill this process on cancellation: another host may already use it.
  // An unclaimed reader exits, and a claimed one with no clients expires itself.
  const deadline = Date.now() + 10_000
  while (!failed && Date.now() < deadline) {
    await delay(100, undefined, { signal })
    const client = await connect()
    if (client) return client
  }
  return null
}
