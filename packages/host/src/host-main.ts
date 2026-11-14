import { rm } from "node:fs/promises"
import { join } from "node:path"
import { processHostConfig } from "./host-config.js"
import { createHost } from "./create-host.js"
import { acquireSuccessorLock, hostLifecycle, nodeHostExit, stopOnSignals, takePredecessor } from "./base/host-lifecycle.js"
import { takeHostStart } from "./base/host-start.js"
import { probeRuntime, settleRuntime } from "./transport/index.js"
import { hostLog, hostWarn, installHostLog, logsRoot } from "./base/host-log.js"
import { installCrashReporting } from "./base/crash.js"
import { compileCacheStatus } from "./base/compile-cache.js"

/**
 * The host as a program: what belongs to the process rather than to the host
 * it runs. The configuration it was started with, its log, its lock on the
 * data root, its signals and its exit. Everything else is `createHost`.
 */
const exit = nodeHostExit()
const config = processHostConfig()
if ("refused" in config) {
  process.stderr.write(`${config.refused}\n`)
  process.exit(config.code)
}
const { environment } = config
/** How long a host waits out a `mako-host` command holding its lock before it refuses to start. */
const CLI_HOLD_MS = 3_000
const log = installHostLog(join(logsRoot(environment.dataRoot), "host.log"))
hostLog("host", "starting", {
  pid: process.pid,
  version: environment.version,
  profile: environment.profile || "default",
  electron: process.versions.electron ?? "",
  node: process.versions.node ?? "",
  dataRoot: environment.dataRoot,
  compileCache: compileCacheStatus(),
})
// A `mako-host` command that took the lock to read (a `status` of a build before this one, a `join` ending) lets go
// within a moment, so it's waited out, briefly: a host polled with `status` as it started once exited as already
// running. Whatever answers on the socket is a host, refused at once, and a holder that stays is refused at the bound.
const lock = await acquireSuccessorLock(environment.dataRoot, takePredecessor(), {
  log: (message, fields) => hostWarn("host", message, fields),
  brief: { ms: CLI_HOLD_MS, listening: () => probeRuntime(config.socket, { timeoutMs: 1_000 }).then((probe) => probe.state === "ready", () => true) },
})
// A host from before this lock holds only Electron's, and answers on the socket once it listens.
// A socket that neither answers nor refuses counts as occupied.
const olderHost = lock.kind === "held"
  ? await settleRuntime(config.socket, { timeoutMs: 2_000 }).then((probe) => probe.state !== "absent", () => true)
  : false
if (lock.kind === "taken" || olderHost) {
  hostWarn("host", "another host holds this data root", {
    dataRoot: environment.dataRoot,
    holder: lock.kind === "taken" ? lock.holder : null,
    olderHost,
  })
  console.error(lock.kind === "taken" && "stuck" in lock
    ? `Mako's previous host is stuck and couldn't be ended: ${lock.stuck}.`
    : "Mako is already running. Close the existing desk host before starting another desktop or web host.")
  // Exiting drops queued log writes; this line is the only record a detached launch leaves.
  await log.flush()
  exit(1, false)
}
// Earlier builds drafted with Kiri and cached its analyses here; nothing reads them now.
void rm(join(environment.dataRoot, "kiri-analysis-cache"), { recursive: true, force: true })
  .catch((error: Error) => hostWarn("git", "retired Kiri cache not removed", { error: error.message }))
const crashes = installCrashReporting({ root: environment.dataRoot, version: environment.version })

const lifecycle = hostLifecycle({
  cleanup: async () => {
    await host.stop()
    await log.flush()
    // The data root goes to whoever's next (a restart's or an update's host) as this one finishes, not when the kernel
    // has torn its process down: on macOS that has taken seconds after its exit, every thread already gone (15 s on a
    // CI runner, 2026-11-13), and the next host waited on the lock all that while.
    if (lock.kind === "held") await lock.release()
  },
  exit,
  log: (message, fields) => hostLog("lifecycle", message, fields),
  failed: async (error) => {
    hostWarn("lifecycle", "shutdown failed", { error: String(error) })
    await log.flush()
  },
})
// The lock is held: this start's generation on the data root is taken now, one past the last, before anything says it.
const start = takeHostStart(environment.dataRoot)
const host = createHost(config, { lifecycle, crashes, logPath: log.path, start })
stopOnSignals(lifecycle)
await host.start().catch(async (error: Error) => {
  // The launcher shows this process's output; the log keeps the stack.
  console.error(`Mako's host couldn't start: ${error.message}`)
  await lifecycle.stop({ kind: "failed", error: error.stack ?? error.message })
})
