import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { connectDaemon, defaultCatalogIdentity, onDemandCatalogPaths, type DaemonClient } from "@mako/sessions"
import { daemonIsForeign } from "./daemon-vintage.js"
import { ON_DEMAND_CATALOG_NODE_ARGS } from "./daemon-command.js"
import { headlessNodeExecutable } from "../base/headless-node.js"

/**
 * Join a compatible on-demand reader, starting one unless `start` is false.
 * Its own claim arbitrates simultaneous starts: a reader that leaves for
 * another exits 0 and the wait goes on, one that can't serve exits otherwise
 * and the wait ends there. Throws when the reader it started can't be joined.
 */
export async function connectOnDemandCatalog(signal: AbortSignal, { script, start = true }: { script: string; start?: boolean }): Promise<DaemonClient | null> {
  const identity = await defaultCatalogIdentity(join(homedir(), ".mako", "archive"))
  signal.throwIfAborted()
  const { socket } = onDemandCatalogPaths(identity)
  const connect = async () => {
    const client = await connectDaemon(socket, 500).catch(() => null)
    if (!client) return null
    if (signal.aborted || daemonIsForeign(client.stats, script, identity)) {
      client.close()
      signal.throwIfAborted()
      return null
    }
    return client
  }
  const existing = await connect()
  if (existing || !start) return existing
  signal.throwIfAborted()
  const child = spawn(headlessNodeExecutable(), [...ON_DEMAND_CATALOG_NODE_ARGS, script, "--on-demand"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  })
  let failed: string | undefined
  child.once("error", (error) => { failed = `could not start: ${error.message}` })
  child.once("exit", (code, exitSignal) => {
    if (code !== 0) failed = exitSignal ? `stopped by ${exitSignal}` : `exited with code ${code}`
  })
  child.unref()
  // Do not kill this process on cancellation: another host may already use it.
  // An unclaimed reader exits, and a claimed one with no clients expires itself.
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await delay(100, undefined, { signal })
    const client = await connect()
    if (client) return client
    if (failed) throw new Error(`The shared catalog reader ${failed}`)
  }
  throw new Error("The shared catalog reader didn't answer within 10 s")
}
