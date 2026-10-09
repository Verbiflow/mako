import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runtimeLocation } from "../dist-electron/runtime-service.js"
import { probeRuntime } from "../dist-electron/runtime-connection.js"

// One host per data root. Two clients that find no host can both start one;
// exactly one may serve, the other leaves before touching the data, and a host
// that was killed outright never keeps the next one out.
const executable = createRequire(import.meta.url)("electron")
const root = await mkdtemp(join(tmpdir(), "mako-host-single-"))
const home = join(root, "home")
const dataRoot = join(root, "data")
const location = runtimeLocation(dataRoot)
await mkdir(home, { recursive: true })
await mkdir(location.directory, { recursive: true, mode: 0o700 })
const env = {
  ...process.env,
  HOME: home,
  MAKO_HOST_ONLY: "1",
  MAKO_DATA_ROOT: dataRoot,
  MAKO_WEB_SOCKET: location.socket,
  MAKO_WEB_ONLY: "1",
  MAKO_PROFILE: "single-host",
}
for (const key of ["ELECTRON_RUN_AS_NODE", "MAKO_PROD", "MAKO_STANDALONE", "VITE_DEV_SERVER_URL", "CLAUDE_CONFIG_DIR"]) delete env[key]
const hosts = []
const exits = new Map()
const start = () => {
  const host = spawn(executable, [resolve(".")], { env, stdio: "ignore" })
  hosts.push(host)
  exits.set(host, once(host, "exit"))
  return host
}

async function ready(deadlineMs = 60_000) {
  const until = Date.now() + deadlineMs
  for (;;) {
    const probe = await probeRuntime(location.socket)
    if (probe.state === "ready") return probe.info
    assert.ok(Date.now() < until, "A host became ready")
    await new Promise((done) => setTimeout(done, 100))
  }
}

try {
  const racing = [start(), start()]
  const info = await ready()
  const winner = racing.find((host) => host.pid === info.pid)
  const loser = racing.find((host) => host !== winner)
  assert.ok(winner && loser, "The host serving the socket is one of the two started")
  const [code] = await Promise.race([
    exits.get(loser),
    new Promise((_, reject) => setTimeout(() => reject(new Error("The second host kept running")), 30_000).unref()),
  ])
  assert.equal(code, 1, "The second host exits with failure")
  assert.equal(winner.exitCode, null, "The first host keeps serving")
  const log = await readFile(join(dataRoot, "logs", "host.log"), "utf8")
  assert.match(log, new RegExp(`another host holds this data root .*holder=${winner.pid}`), "The refusal names the holder")

  winner.kill("SIGKILL")
  await exits.get(winner)
  const next = start()
  const replaced = await ready()
  assert.equal(replaced.pid, next.pid, "A host started after a kill serves, despite the socket file left behind")
  console.log("Single host: of two started together one serves and the other leaves naming it; a killed host's lock and socket don't block the next")
} finally {
  for (const host of hosts) if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL")
  await rm(root, { recursive: true, force: true })
  await rm(location.directory, { recursive: true, force: true })
}
