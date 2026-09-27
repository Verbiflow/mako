import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runtimeLocation } from "../dist-electron/runtime-service.js"
import { probeRuntime } from "../dist-electron/runtime-connection.js"

// A persistent host must shut down, with cleanup, on the signals a session
// ending, a closed terminal or Ctrl+C send. Electron's own one-shot handlers
// turn the first into app.quit(), which a persistent host declines, and the
// second into an abrupt kill.
const executable = createRequire(import.meta.url)("electron")
const root = await mkdtemp(join(tmpdir(), "mako-host-signals-"))

async function stopsOn(signal) {
  const home = join(root, signal, "home")
  const dataRoot = join(root, signal, "data")
  await mkdir(home, { recursive: true })
  const location = runtimeLocation(dataRoot)
  await mkdir(location.directory, { recursive: true, mode: 0o700 })
  const env = {
    ...process.env,
    HOME: home,
    MAKO_HOST_ONLY: "1",
    MAKO_DATA_ROOT: dataRoot,
    MAKO_WEB_SOCKET: location.socket,
    MAKO_WEB_ONLY: "1",
    MAKO_RELAY: "0",
    MAKO_PROFILE: `signals-${signal.toLowerCase()}`,
    MAKO_BACKEND_URL: "http://127.0.0.1:9/api/mcp",
    MAKO_BACKEND_TOKEN: "",
  }
  for (const key of ["ELECTRON_RUN_AS_NODE", "MAKO_PROD", "MAKO_STANDALONE", "VITE_DEV_SERVER_URL", "CLAUDE_CONFIG_DIR"]) delete env[key]
  const host = spawn(executable, [resolve(".")], { env, stdio: "ignore" })
  const exited = once(host, "exit")
  try {
    const ready = Date.now() + 60_000
    while ((await probeRuntime(location.socket)).state !== "ready") {
      assert.ok(Date.now() < ready, `The host became ready before ${signal}`)
      assert.equal(host.exitCode, null, "The host stayed up while starting")
      await new Promise((done) => setTimeout(done, 100))
    }
    const sent = Date.now()
    host.kill(signal)
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`The host ignored ${signal} for 20 s`)), 20_000))
    const [code, killedBy] = await Promise.race([exited, timeout])
    const log = await readFile(join(dataRoot, "logs", "host.log"), "utf8")
    assert.equal(killedBy, null, `${signal} ended the host through its own quit, not the default action`)
    assert.equal(code, 0, `The host exited cleanly on ${signal}`)
    assert.match(log, new RegExp(`lifecycle stopping signal=${signal}`), "The host logged the signal")
    assert.match(log, /lifecycle stopped/, "Cleanup ran to the end")
    return Date.now() - sent
  } finally {
    if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL")
  }
}

try {
  const results = []
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) results.push(`${signal} ${await stopsOn(signal)} ms`)
  console.log(`host signals: a persistent host stops with cleanup on ${results.join(", ")}`)
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
