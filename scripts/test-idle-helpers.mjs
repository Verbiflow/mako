import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { probeRuntime } from "@mako/host/transport/connection"
import { runtimeLocation } from "@mako/host/transport/service"
import { helperName, hostProcesses } from "./lib/host-processes.mjs"

/**
 * A host nobody is using keeps no helper process, on a Mac, on Linux and on Windows: with no window subscribed and no
 * project open, the file watcher's child has nothing to watch (the plugins folder is followed only while a window
 * hears of it), no Git helper runs, and nobody reads what the harnesses' processes do, so the probes' child, which
 * a Mac's half-minute `lsof` for each harness kept alive, has nothing to run. Each is some 25 MB that an idle host
 * held for nothing. What the host starts as it boots goes after its idle wait, and none comes back: the watch after
 * that is longer than the harnesses' half-minute look was.
 */
const windows = process.platform === "win32"
const scratch = await mkdtemp(join(tmpdir(), "mako-idle-helpers-"))
const dataRoot = join(scratch, "data")
const hostCli = resolve("packages/host/dist/mako-host.js")
const env = { ...process.env, MAKO_PROD: "1", MAKO_TELEMETRY: "off", MAKO_DATA_ROOT: dataRoot }
for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "VITE_DEV_SERVER_URL", "MAKO_WEB_SOCKET"]) delete env[key]
// Windows draws a pipe for each start and publishes it; elsewhere the socket is named here, in a folder of its own.
if (!windows) Object.assign(env, { HOME: scratch, MAKO_WEB_SOCKET: join(scratch, "run", "h.sock") })
const host = spawn(process.execPath, [hostCli], { env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true })
let said = ""
host.stderr.on("data", (data) => { said = (said + data).slice(-4000) })
const socket = () => env.MAKO_WEB_SOCKET ?? runtimeLocation(dataRoot).socket

/** The host's helper processes running now, each by what it is. */
const helpers = async () => (await hostProcesses(host.pid)).flatMap((row) => helperName(row.command) ?? [])

try {
  for (const deadline = Date.now() + 90_000; ; await delay(200)) {
    assert.ok(Date.now() < deadline, `The host's core loaded within 90 s. The host said: ${said}`)
    assert.equal(host.exitCode, null, `The host exited as it started: ${said}`)
    const probe = await probeRuntime(socket(), { timeoutMs: 2_000 }).catch(() => undefined)
    if (probe?.state === "ready" && probe.info.domains?.find((domain) => domain.name === "core")?.state === "ready") break
  }
  // What the host does once its core is ready may start any of them (a `git` in the folder it was started in, a watch
  // made and let go, the probes its own launches ask): each then goes 30 s after its last work.
  await delay(10_000)
  for (const deadline = Date.now() + 75_000; ; await delay(1_000)) {
    const running = await helpers()
    if (!running.length) break
    assert.ok(Date.now() < deadline, `An idle host with no window keeps no helper process, but ${running.join(" and ")} still ran after 75 s`)
  }
  for (const until = Date.now() + 40_000; Date.now() < until; await delay(2_000))
    assert.deepEqual(await helpers(), [], "and starts none while it idles")
  console.log(`idle helpers: a host with no window and no project runs no watcher child and no Git helper (${process.platform})`)
} finally {
  if (windows) {
    // No signal ends a Windows host gracefully: it is asked to stop, and ended with its tree if that fails.
    const run = promisify(execFile)
    const folder = runtimeLocation(dataRoot).directory
    await run(process.execPath, [hostCli, "stop", "--data-root", dataRoot, "--now", "--timeout", "30"], { env, timeout: 60_000 }).catch(() => undefined)
    if (host.exitCode === null) await run("taskkill", ["/PID", String(host.pid), "/T", "/F"]).catch(() => undefined)
    await Promise.race([once(host, "exit"), delay(10_000)])
    await rm(folder, { recursive: true, force: true }).catch(() => undefined)
  } else {
    host.kill("SIGTERM")
    await Promise.race([once(host, "exit"), delay(10_000)])
    host.kill("SIGKILL")
  }
  await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }).catch(() => undefined)
}
