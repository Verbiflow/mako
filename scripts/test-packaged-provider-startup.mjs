import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { extractFile } from "@electron/asar"
import WebSocket from "ws"
import { runtimeLocation } from "../dist-electron/runtime-service.js"
import { invokeRuntime, probeRuntime } from "../dist-electron/runtime-connection.js"
import { launchEvidence, verifyLaunchEvidence } from "./provider-launch-evidence.mjs"

assert.ok(process.argv[2], "Pass a packaged or installed Mako.app")
const app = await realpath(resolve(process.argv[2]))
const root = await realpath(await mkdtemp(join(tmpdir(), "mako-packaged-provider-startup-")))
const dataRoot = join(root, "profile")
const { socket, directory } = runtimeLocation(dataRoot)
const client = randomUUID()
const metadata = JSON.parse(extractFile(join(app, "Contents/Resources/app.asar"), "package.json").toString())
const expectTrace = process.argv.includes("--expect-trace")
const traceWatchClose = process.argv.includes("--trace-watch-close")
const requested = process.argv.slice(3).filter(arg => !arg.startsWith("--"))
const report = { app, build: metadata.makoBuild, root, results: [], status: "running" }
const call = (channel, ...args) => invokeRuntime(socket, client, channel, args)
const env = { ...process.env, MAKO_DATA_ROOT: dataRoot, MAKO_HOST_ONLY: "1",
  MAKO_WEB_ONLY: "1", MAKO_WEB_SOCKET: socket,
  MAKO_CURSOR_SDK_ROOT: join(root, "cursor"), MAKO_RELAY: "0",
  MAKO_BACKEND_URL: "http://127.0.0.1:9/api/mcp", MAKO_BACKEND_TOKEN: "" }
for (const key of ["ELECTRON_RUN_AS_NODE", "VITE_DEV_SERVER_URL", "MAKO_PROFILE", "MAKO_STANDALONE", "MAKO_PROD"])
  delete env[key]
await mkdir(directory, { recursive: true })
const host = spawn(join(app, "Contents/MacOS/Mako"), ["--background", ...(traceWatchClose ? ["--inspect=127.0.0.1:0"] : [])],
  { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] })
let inspectorUrl
host.stderr.on("data", chunk => {
  inspectorUrl ??= /Debugger listening on (ws:\/\/[^\s]+)/.exec(chunk.toString())?.[1]
})
let identity
const started = []
async function until(read, predicate, label, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (predicate(value)) return value
    await delay(100)
  }
  throw new Error(`Timed out: ${label}`)
}
console.log(`Private packaged launch fixture: ${root}`)
try {
  const ready = await until(() => probeRuntime(socket, { timeoutMs: 1000 }), value => value.state === "ready", "private host")
  identity = ready.info
  report.host = { pid: identity.pid, instanceId: identity.instanceId }
  if (traceWatchClose) {
    await until(async () => inspectorUrl, Boolean, "private main-process inspector", 5000)
    const debuggerSocket = new WebSocket(inspectorUrl)
    await once(debuggerSocket, "open")
    try {
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Watcher instrumentation timed out")), 5000)
        debuggerSocket.on("message", bytes => {
          const message = JSON.parse(bytes.toString())
          if (message.id !== 1) return
          clearTimeout(timer)
          if (message.error || message.result?.exceptionDetails)
            reject(new Error(message.error?.message ?? message.result.exceptionDetails.exception?.description ?? "Watcher instrumentation failed"))
          else resolve(message)
        })
      })
      debuggerSocket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { returnByValue: true,
        expression: `(()=>{const fs=process.getBuiltinModule('node:fs');const watcher=process._getActiveHandles().find(handle=>handle.constructor.name==='FSWatcher');if(!watcher)throw Error('No active main-process filesystem watcher');const prototype=Object.getPrototypeOf(watcher);const close=prototype.close;prototype.close=function(...args){const start=performance.now();fs.appendFileSync(${JSON.stringify(join(root, "watch-close.jsonl"))},JSON.stringify({event:'close-start',stack:new Error().stack})+'\\n');try{return Reflect.apply(close,this,args)}finally{fs.appendFileSync(${JSON.stringify(join(root, "watch-close.jsonl"))},JSON.stringify({event:'close-return',elapsedMs:performance.now()-start})+'\\n')}}})()` } }))
      await response
      report.watchCloseInstrumented = true
    } finally { debuggerSocket.close() }
  }
  const descriptors = await call("mako:harness-descriptors")
  const drivers = descriptors.filter(driver => driver.live && (!requested.length || requested.includes(driver.provider)))
  assert.ok(drivers.length, "No live providers found")
  for (const provider of requested) assert.ok(drivers.some(driver => driver.provider === provider), `Missing live provider: ${provider}`)
  const logPath = await call("mako:host-log-path")
  for (const driver of drivers) {
    const id = randomUUID()
    const cwd = join(root, driver.provider)
    await mkdir(cwd)
    started.push(id)
    const result = { provider: driver.provider, conversation: id, status: "running" }
    report.results.push(result)
    const began = performance.now()
    try {
      await call("mako:live-start", driver.provider, cwd, { conversationId: id, title: "Mako disposable launch fixture" })
      const snapshot = await until(() => call("mako:live-snapshot", id), value => {
        if (value?.session.status === "error") throw new Error(value.session.error ?? "Native startup failed")
        return value?.session.status === "ready"
      }, `${driver.provider} ready`)
      result.readyMs = performance.now() - began
      result.nativeId = snapshot.session.nativeId
      assert.ok(result.nativeId, "Ready must include native identity")
      result.status = "passed"
      if (expectTrace) {
        result.phases = await until(async () => launchEvidence(await readFile(logPath, "utf8"), id),
          records => records.at(-1)?.phase === "launch" && records.at(-1)?.state === "done", "launch trace flush", 5000)
        verifyLaunchEvidence(result.phases)
      }
    } catch (error) {
      result.status = "failed"
      result.error = error.message
      result.elapsedMs = performance.now() - began
      if (logPath) result.phases = launchEvidence(await readFile(logPath, "utf8").catch(() => ""), id)
    } finally {
      await call("mako:live-close", id).catch(error => { result.cleanupError = error.message; result.status = "failed" })
    }
    console.log(JSON.stringify({ ...result, phases: undefined, nativeId: undefined }))
    await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2))
  }
  report.status = report.results.every(result => result.status === "passed") ? "passed" : "failed"
} catch (error) {
  report.status = "failed"
  report.error = error.message
} finally {
  // Only the host on this randomly allocated profile is eligible for cleanup.
  const current = await probeRuntime(socket, { timeoutMs: 1000 })
  if (current.state === "ready" && (!identity || current.info.instanceId === identity.instanceId)) {
    for (const id of started) await call("mako:live-close", id).catch(() => {})
    report.shutdown = await call("mako:lifecycle-command", { kind: "wait", action: "quit" }).catch(error => { report.cleanupError = error.message })
    await until(() => probeRuntime(socket, { timeoutMs: 1000 }), value => value.state !== "ready", "private host shutdown", 15_000)
      .catch(error => { report.cleanupError = error.message })
  } else if (current.state === "ready") report.cleanupError = "Private host identity changed"
  if (host.exitCode === null && host.signalCode === null) {
    // Socket removal precedes process exit. Observe graceful exit before signalling.
    let sample
    const timer = setTimeout(() => {
      if (host.exitCode === null && host.signalCode === null)
        sample = promisify(execFile)("/usr/bin/sample", [String(host.pid), "1", "10", "-file", join(root, "shutdown.sample.txt")]).catch(() => {})
    }, 2000)
    await until(async () => host.exitCode !== null || host.signalCode !== null, Boolean, "spawned fixture exit", 10_000)
      .catch(() => { host.kill("SIGKILL"); report.cleanupError = "Spawned fixture required forced cleanup" })
    clearTimeout(timer)
    await sample
  }
  if (report.cleanupError) report.status = "failed"
  await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2))
}
process.exitCode = report.status === "passed" ? 0 : 1
console.log(`Packaged provider startup ${report.status}: ${root}/result.json`)
