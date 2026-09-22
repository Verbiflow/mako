import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import WebSocket from "ws"
import { runtimeLocation } from "../dist-electron/runtime-service.js"
import {
  runtimeInfo,
  invokeRuntime,
} from "../dist-electron/runtime-connection.js"

assert.ok(process.argv[2], "Pass the packaged Mako.app to test")
const launchServices = process.argv.includes("--launch-services")
const run = promisify(execFile)
const app = await realpath(resolve(process.argv[2]))
const root = await realpath(
  await mkdtemp(join(tmpdir(), "mako-packaged-startup-"))
)
const workspace = join(root, "workspace")
const dataRoot = join(root, "profile")
const uiRoot = `${dataRoot}-ui-package-startup`
await mkdir(workspace)
const { socket } = runtimeLocation(dataRoot)
const env = {
  ...process.env,
  MAKO_DATA_ROOT: dataRoot,
  MAKO_CURSOR_SDK_ROOT: join(root, "cursor"),
  MAKO_CLIENT_ID: "package-startup",
  MAKO_BACKEND_URL: "http://127.0.0.1:9/api/mcp",
  MAKO_BACKEND_TOKEN: "",
  MAKO_RELAY: "0",
}
for (const key of [
  "ELECTRON_RUN_AS_NODE",
  "MAKO_PROFILE",
  "MAKO_PROD",
  "MAKO_STANDALONE",
  "MAKO_HOST_ONLY",
  "MAKO_WEB_ONLY",
  "MAKO_WEB_SOCKET",
  "VITE_DEV_SERVER_URL",
])
  delete env[key]
const clients = []
let host
let debuggerSocket
let sequence = 0
const pending = new Map()
const report = {
  app,
  mode: launchServices ? "launch-services-shared-client" : "packaged-shared-client",
  outcome: "running",
  root,
  phases: [],
}

async function until(read, label, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await delay(100)
  }
  throw new Error(`Packaged shared-client startup failed: ${label}`)
}
function alive(child) {
  return child.exitCode === null && child.signalCode === null
}
function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === "ESRCH") return false
    throw error
  }
}
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out`))
    }, 15_000)
    pending.set(id, { resolve, reject, timer })
    debuggerSocket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails)
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text
    )
  return result.result.value
}
function detach() {
  for (const callback of pending.values()) {
    clearTimeout(callback.timer)
    callback.reject(new Error("Test debugger closed"))
  }
  pending.clear()
  debuggerSocket?.close()
  debuggerSocket = undefined
}
async function launch() {
  const started = performance.now()
  const executable = join(app, "Contents/MacOS/Mako")
  const flags = ["--background", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1"]
  // Finder/Dock launch through LaunchServices. Direct exec alone misses -600
  // from stale or hidden registrations. -W tracks the client's whole lifetime.
  const child = launchServices
    ? spawn("/usr/bin/open", ["-W", "-n", "-g", "-a", app,
        ...Object.entries(env).filter(([key]) => key.startsWith("MAKO_")).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
        "--args", ...flags], { env, stdio: "ignore" })
    : spawn(executable, flags, { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] })
  child.stdout?.on("data", (chunk) => process.stdout.write(chunk))
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk))
  clients.push(child)
  let launchError
  child.once("error", (error) => {
    launchError = error
  })
  if (launchServices) {
    child.clientPid = await until(async () => {
      if (!alive(child)) throw new Error("LaunchServices failed to launch the client")
      const { stdout } = await run("ps", ["-axo", "pid=,ppid=,comm="])
      const processes = stdout.split("\n").flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
        return match && match[3] === executable ? [{ pid: Number(match[1]), parent: Number(match[2]) }] : []
      })
      const roots = processes.filter((process) => process.pid !== host?.pid && !processes.some((parent) => parent.pid === process.parent))
      assert.ok(roots.length <= 1, "Only one test desktop client may run")
      return roots[0]?.pid
    }, "LaunchServices did not create a desktop process")
  } else child.clientPid = child.pid
  const current = await until(async () => {
    if (launchError) throw launchError
    if (!alive(child))
      throw new Error(
        `Packaged client exited: ${child.exitCode ?? child.signalCode}`
      )
    return runtimeInfo(socket)
  }, "the desktop client did not start its shared host")
  if (host)
    assert.equal(
      current.instanceId,
      host.instanceId,
      "Reopening a client must reuse the existing host"
    )
  host = current
  const { stdout: presence } = await run("/usr/bin/lsappinfo", ["info", "-only", "ApplicationType", String(host.pid)])
  assert.match(presence, /UIElement|BackgroundOnly/, "An isolated test host must never claim a Dock icon")
  assert.notEqual(
    host.pid,
    child.clientPid,
    "The test must exercise the separate packaged host, not standalone mode"
  )
  const target = await until(async () => {
    let port
    try {
      port = Number(
        (await readFile(join(uiRoot, "DevToolsActivePort"), "utf8")).split(
          "\n"
        )[0]
      )
    } catch (error) {
      if (error.code === "ENOENT") return null
      throw error
    }
    if (!port) return null
    try {
      return (
        await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      ).find((page) => page.type === "page" && page.url.startsWith("mako-app:"))
    } catch {
      return null
    }
  }, "the packaged renderer did not open")
  debuggerSocket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    debuggerSocket.once("open", resolve)
    debuggerSocket.once("error", reject)
  })
  debuggerSocket.on("message", (data) => {
    const message = JSON.parse(data.toString())
    const callback = pending.get(message.id)
    if (!callback) return
    pending.delete(message.id)
    clearTimeout(callback.timer)
    if (message.error) callback.reject(new Error(message.error.message))
    else callback.resolve(message.result)
  })
  await until(
    () =>
      evaluate(
        "Boolean(window.mako && document.querySelector('.composer-input:not([readonly])'))"
      ),
    "the real preload, host, and editable composer did not become ready"
  )
  const cwd = await evaluate(
    "window.mako.boot().then(boot => boot.tabs.find(tab => tab.id === boot.activeTabId).session.meta.cwd)"
  )
  if (!launchServices) assert.equal(
    await realpath(cwd),
    workspace,
    "Packaged startup must preserve the real launch working directory, not use app.asar or Resources"
  )
  report.phases.push({
    phase: "desktop-ready",
    elapsedMs: Math.round(performance.now() - started),
    clientPid: child.clientPid,
    hostPid: host.pid,
  })
  if (launchServices) {
    await run("/usr/bin/open", ["-g", app])
    assert.ok(processAlive(child.clientPid), "Finder reopen must retain a live desktop client")
    report.phases.push({ phase: "finder-reopen", passed: true })
  }
  return child
}

try {
  const first = await launch()
  const draft = `Packaged startup draft ${Date.now()}`
  await evaluate("document.querySelector('.composer-input').focus()")
  await command("Input.insertText", { text: draft })
  await until(
    () =>
      evaluate(
        `document.querySelector('.composer-input')?.value === ${JSON.stringify(draft)}`
      ),
    "trusted draft input was not retained"
  )
  await evaluate("void window.mako.quitClient()")
  await until(() => !alive(first), "normal client Quit did not finish")
  detach()
  const remaining = await runtimeInfo(socket)
  assert.equal(
    remaining?.instanceId,
    host.instanceId,
    "Quitting the client must leave its shared host running"
  )
  const reopened = await launch()
  await until(
    () =>
      evaluate(
        `document.querySelector('.composer-input')?.value === ${JSON.stringify(draft)}`
      ),
    "reopening the packaged client lost the draft"
  )
  const screenshot = await command("Page.captureScreenshot", { format: "png" })
  await writeFile(
    join(root, "packaged-client.png"),
    Buffer.from(screenshot.data, "base64")
  )
  await evaluate("void window.mako.lifecycleCommand({kind:'wait',action:'quit'})")
  await until(() => !alive(reopened), "shared-host shutdown did not close its client")
  await until(() => !processAlive(host.pid), "shared-host shutdown did not terminate the host")
  report.phases.push({ phase: "shared-shutdown", passed: true })
  report.outcome = "passed"
  console.log(
    "Packaged cold startup, real host/preload/composer, launch directory, client Quit/reopen, shared-host reuse, and draft persistence passed"
  )
} catch (error) {
  report.outcome = "failed"
  report.error = error.message
  process.exitCode = 1
  console.error(error.message)
} finally {
  detach()
  // A host stuck before binding its socket is still ours to clean up. Record
  // its parent before terminating the client, which would reparent it to pid 1.
  const { stdout: processes } = await run("ps", ["-axo", "pid=,ppid=,comm="])
  const clientPids = new Set(clients.map((child) => child.clientPid ?? child.pid))
  const unreadyHosts = processes.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
    return match && clientPids.has(Number(match[2])) && match[3] === join(app, "Contents/MacOS/Mako")
      ? [Number(match[1])] : []
  })
  for (const child of clients)
    if (alive(child)) {
      if (child.clientPid && processAlive(child.clientPid)) process.kill(child.clientPid, "SIGTERM")
      else child.kill("SIGTERM")
      await until(() => !alive(child), "owned test client cleanup", 5000).catch(
        () => {
          if (child.clientPid && processAlive(child.clientPid)) process.kill(child.clientPid, "SIGKILL")
          if (alive(child)) child.kill("SIGKILL")
        }
      )
    }
  const current = await runtimeInfo(socket)
  if (current && (!host || current.instanceId === host.instanceId)) {
    await invokeRuntime(socket, randomUUID(), "mako:lifecycle-command", [
      { kind: "wait", action: "quit" },
    ])
    try {
      await until(
        () => !processAlive(current.pid),
        "owned test host cleanup",
        10_000
      )
    } catch {
      const remaining = await runtimeInfo(socket)
      if (remaining) {
        if (remaining.instanceId !== current.instanceId) {
          report.outcome = "failed"
          report.cleanupError = "The test host identity changed during cleanup"
          process.exitCode = 1
        } else {
          process.kill(-current.pid, "SIGKILL")
          report.forcedHostCleanup = true
          report.outcome = "failed"
          process.exitCode = 1
          await until(
            async () => !(await runtimeInfo(socket)),
            "owned test host exit",
            5000
          )
        }
      }
    }
  }
  for (const pid of unreadyHosts) {
    if (!processAlive(pid)) continue
    process.kill(pid, "SIGTERM")
    await until(() => !processAlive(pid), "unready test host cleanup", 5000).catch(() => process.kill(pid, "SIGKILL"))
    report.forcedHostCleanup = true
    report.outcome = "failed"
    process.exitCode = 1
  }
  await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2))
  console.log(`Packaged startup evidence: ${root}`)
}
