import { rm } from "node:fs/promises"
import { join } from "node:path"
import { configureGit } from "@mako/git"
import { restrictNativeStores } from "@mako/sessions/read-only-sqlite"
import { processHostConfig } from "./host-config.js"
import { createHost } from "./create-host.js"
import { hostLifecycle, nodeHostExit, stopOnSignals, takePredecessor } from "./base/host-lifecycle.js"
import { acquireHostLock } from "./base/host-lock.js"
import { settleRuntime } from "./transport/index.js"
import { hostLog, hostWarn, installHostLog, logsRoot } from "./base/host-log.js"
import { installCrashReporting } from "./base/crash.js"
import { compileCacheStatus } from "./base/compile-cache.js"
import { belowAgents } from "./base/background-priority.js"

/**
 * The host as a program: what belongs to the process rather than to the host
 * it runs. The configuration it was started with, its log, its lock on the
 * data root, its signals and its exit. Everything else is `createHost`.
 */

/** A Git process slower than this is logged. */
const GIT_SLOW_MS = 2_000

const exit = nodeHostExit()
const config = processHostConfig()
if ("refused" in config) {
  process.stderr.write(`${config.refused}\n`)
  process.exit(config.code)
}
const { environment } = config
if (config.fixtureDesk) restrictNativeStores()
const log = installHostLog(join(logsRoot(environment.dataRoot), "host.log"))
configureGit({
  background: belowAgents,
  // Every Git process with MAKO_GIT_TRACE=1; otherwise the slow ones and those stopped for time, to explain a stall.
  // Failures alone are routine: probes such as `rev-parse --verify` fail by design.
  trace: (run) => {
    const traced = process.env.MAKO_GIT_TRACE === "1"
    if (!traced && run.ms < GIT_SLOW_MS && run.outcome !== "timeout") return
    // A remote URL in Git's error output can carry a token.
    const stderr = traced && run.stderr ? { stderr: run.stderr.replace(/\/\/[^/@\s]+@/g, "//***@") } : {}
    hostLog("git", `${run.command} ${run.outcome}`, { args: run.args.slice(0, 6).join(" ").slice(0, 200), cwd: run.cwd, ms: Math.round(run.ms), queuedMs: Math.round(run.queuedMs), code: run.code ?? -1, bytes: run.bytes, ...stderr })
  },
})
hostLog("host", "starting", {
  pid: process.pid,
  version: environment.version,
  profile: environment.profile || "default",
  electron: process.versions.electron ?? "",
  node: process.versions.node ?? "",
  dataRoot: environment.dataRoot,
  compileCache: compileCacheStatus(),
})
const lock = await acquireHostLock(environment.dataRoot, { predecessor: takePredecessor() })
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
  console.error("Mako is already running. Close the existing desk host before starting another desktop or web host.")
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
  },
  exit,
  log: (message, fields) => hostLog("lifecycle", message, fields),
  failed: async (error) => {
    hostWarn("lifecycle", "shutdown failed", { error: String(error) })
    await log.flush()
  },
})
const host = createHost(config, { lifecycle, crashes, logPath: log.path })
stopOnSignals(lifecycle)
await host.start().catch(async (error: Error) => {
  // The launcher shows this process's output; the log keeps the stack.
  console.error(`Mako's host couldn't start: ${error.message}`)
  await lifecycle.stop({ kind: "failed", error: error.stack ?? error.message })
})
