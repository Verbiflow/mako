import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { capped, changedSince, socketsOf, systemPortsFrom, writingOf } from "../electron/app-probe.js"
import { AppKeySchema } from "../electron/contracts/thread-environments.js"
import { portListening } from "../electron/thread-environment.js"
import { ThreadProcesses } from "../electron/thread-processes.js"

/**
 * The probe against a real app: the ports it listens on, inside the
 * Thread's block and outside it, the service it connects to, files it holds
 * open for writing outside its checkout, a process it started that left its
 * tree, and the folder it keeps state in, all from what the system shows.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-app-probe-")))
const records = join(root, "records")
const checkout = join(root, "checkout")
const home = join(root, "home")
const support = join(home, "Library", "Application Support")
for (const folder of [checkout, join(support, "probe-app"), join(support, "other-app")]) mkdirSync(folder, { recursive: true })
const old = new Date(Date.now() - 3_600_000)
for (const folder of [join(support, "probe-app"), join(support, "other-app")]) utimesSync(folder, old, old)
const shared = join(root, "shared.db")
const escaped = join(root, "escaped.pid")

const service = createServer((socket) => socket.on("error", () => {}))
await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve))
const servicePort = (service.address() as { port: number }).port

async function free(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as { port: number }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
const port = await free()
const outside = await free()

const app = join(root, "app.cjs")
writeFileSync(app, `
const fs = require("node:fs"), net = require("node:net"), { spawn } = require("node:child_process")
const [port, outside, service, shared, inside, state, escaped] = process.argv.slice(2)
net.createServer().listen(Number(port), "127.0.0.1")
net.createServer().listen(Number(outside), "127.0.0.1")
const client = net.connect(Number(service), "127.0.0.1")
client.on("error", () => {})
fs.openSync(shared, "a")
fs.openSync(inside, "a")
fs.writeFileSync(state, "{}")
const middle = spawn(process.execPath, ["-e", "const c = require('node:child_process').spawn('sleep', ['60'], { detached: true, stdio: 'ignore' }); require('node:fs').writeFileSync(process.argv[1], String(c.pid)); c.unref()", escaped], { detached: true, stdio: "ignore" })
middle.unref()
setInterval(() => {}, 1000)
`)

const processes = new ThreadProcesses({ root: records, listening: portListening })
const key = AppKeySchema.parse("folder-0123456789abcdef")
let leftover = 0
try {
  const started = await processes.start(key, [{
    kind: "process",
    name: "web",
    command: ["node", app, port, outside, servicePort, shared, join(checkout, "inside.log"), join(support, "probe-app", "state.json"), escaped].map((part) => JSON.stringify(String(part))).join(" "),
    cwd: checkout,
    env: process.env,
    port,
  }])
  assert.deepEqual(started.started, ["web"])
  const [status] = await processes.settle(key, ["process-web"], 15_000, 300)
  assert.equal(status?.state.kind, "running", readFileSync(status!.log, "utf8"))
  for (let tries = 0; !leftover && tries < 50; tries += 1) {
    leftover = Number(readFileSync(escaped, { encoding: "utf8", flag: "a+" })) || 0
    if (!leftover) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(leftover > 0, `the app's escaped process wrote its pid: ${readFileSync(status!.log, "utf8")}`)

  const running = await processes.footprint(key, [checkout])
  assert.ok(running.pids.length > 0)
  assert.ok(!running.pids.includes(leftover), "the escaped process is outside the run's tree")
  assert.deepEqual(running.leftovers.map((entry) => entry.pid), [leftover])
  assert.match(running.leftovers[0]!.command, /sleep 60/)
  assert.ok(running.since !== undefined && running.since <= Date.now())

  const sockets = await socketsOf(running.pids)
  assert.deepEqual(sockets.listening.map((entry) => entry.port).sort((a, b) => a - b), [port, outside].sort((a, b) => a - b))
  assert.ok(sockets.connected.some((entry) => entry.port === servicePort && entry.local), JSON.stringify(sockets.connected))

  const writing = await writingOf(running.pids, [checkout, records])
  assert.deepEqual(writing.map((entry) => entry.path), [shared])

  const changed = await changedSince(running.since!, [checkout], home)
  assert.ok(changed.includes(join(support, "probe-app")), JSON.stringify(changed))
  assert.ok(!changed.includes(join(support, "other-app")))
  assert.ok(!changed.some((path) => path.startsWith(checkout)))

  const owner = await processes.portOwner(servicePort)
  assert.match(processes.ownerName(owner!, key), /which Mako didn't start/)
  assert.match(processes.ownerName((await processes.portOwner(port))!, key), /^this Thread: its process web/)

  await processes.stop(key)
  const after = await processes.footprint(key, [checkout])
  assert.deepEqual(after.pids, [])
  assert.deepEqual(after.leftovers.map((entry) => entry.pid), [leftover], "the stop leaves the escaped process, and the probe still finds it")
  assert.equal(after.since, running.since)

  const picked = await systemPortsFrom()
  assert.ok(picked > 1024 && outside >= picked, "a port the system picked counts as one, so it isn't called fixed")
  assert.deepEqual(capped([1, 2, 3]), { entries: [1, 2, 3] })
  assert.equal(capped(Array.from({ length: 45 }, (_, index) => index)).more, 5)
  console.log("app probe: ports inside and outside the block, a local service, a shared file, a process outside the tree before and after the stop, and a changed state folder")
} finally {
  if (leftover) try { process.kill(leftover, "SIGKILL") } catch { /* already gone */ }
  await processes.stop(key).catch(() => [])
  service.close()
  rmSync(root, { recursive: true, force: true })
}
