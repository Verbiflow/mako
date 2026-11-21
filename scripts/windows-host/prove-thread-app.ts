/**
 * A Thread's app run on Windows, against real processes (`workspaces/thread-processes.ts`): started through Node's
 * wrapper and ComSpec in place of `/bin/sh`, found in Windows' process table (one CIM query, kept a moment) with the
 * processes it started, named as the owner of the port it listens on (`Get-NetTCPConnection`), and stopped with its
 * whole tree. Runs on any system, where it holds the same of `ps` and process groups.
 *
 *   npx tsx scripts/windows-host/prove-thread-app.ts
 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { AppKeySchema } from "@mako/host/contracts/thread-environments"
import { portListening } from "@mako/host/workspaces/thread-environment"
import { ThreadProcesses } from "@mako/host/workspaces/thread-processes"

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-thread-app-")))
const records = join(root, "thread-environments")
mkdirSync(records)
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** A port nothing listens on, as the system picks one. */
const freePort = () => new Promise<number>((done) => {
  const probe = createServer()
  probe.listen(0, "127.0.0.1", () => {
    // SAFETY: a server listening on a TCP port answers its address as an AddressInfo, never a pipe's path.
    const { port } = probe.address() as AddressInfo
    probe.close(() => done(port))
  })
})

const server = join(root, "server.mjs")
const pids = join(root, "pids.json")
writeFileSync(server, `
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true })
createServer((_, response) => response.end("up")).listen(Number(process.env.PORT), "127.0.0.1", () => {
  writeFileSync(process.env.PIDS_FILE, JSON.stringify([process.pid, child.pid]))
  console.log("listening on", process.env.PORT)
})
`)

const processes = new ThreadProcesses({ root: records, listening: portListening })
const app = AppKeySchema.parse(randomUUID())
try {
  const port = await freePort()
  const began = performance.now()
  const result = await processes.start(app, [{ kind: "process", name: "api", command: `node "${server}"`, cwd: root, env: { ...process.env, PORT: String(port), PIDS_FILE: pids }, port }])
  assert.deepEqual(result, { started: ["api"], refused: [] })
  const startMs = Math.round(performance.now() - began)
  let tree: number[] = []
  for (const deadline = Date.now() + 30_000; !tree.length && Date.now() < deadline; await delay(100)) {
    try {
      // SAFETY: the server above writes this file once, as a JSON array of its own pid and its child's.
      tree = JSON.parse(readFileSync(pids, "utf8")) as number[]
    } catch {
      tree = []
    }
  }
  assert.equal(tree.length, 2, "the app came up and said its processes")
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "up")

  // Found: the run is running, with the server and the process it started among its own.
  const status = await processes.status(app)
  assert.equal(status.length, 1)
  assert.equal(status[0]!.name, "api")
  assert.ok(["running", "starting"].includes(status[0]!.state.kind), `the run is found, running: ${JSON.stringify(status[0])}`)
  const report = await processes.footprint(app, [root])
  for (const pid of tree) assert.ok(report.pids.includes(pid), `pid ${pid} is one of the run's: ${JSON.stringify(report.pids)}`)

  // Named as the owner of its port.
  const owner = await processes.portOwner(port)
  assert.equal(owner?.app, app, `the port's owner is this app: ${JSON.stringify(owner)}`)
  assert.deepEqual(owner?.run, { kind: "process", name: "api" })

  // A second start of a running run starts nothing more.
  assert.deepEqual((await processes.start(app, [{ kind: "process", name: "api", command: `node "${server}"`, cwd: root, env: { ...process.env, PORT: String(port), PIDS_FILE: pids }, port }])).started, [])

  // Stopped, with its whole tree.
  const stopBegan = performance.now()
  assert.deepEqual(await processes.stop(app), ["api"])
  for (const deadline = Date.now() + 10_000; tree.some(alive) && Date.now() < deadline; ) await delay(100)
  assert.deepEqual(tree.filter(alive), [], "the server and the process it started are gone")
  assert.equal(await portListening(port), false, "nothing listens on its port")
  assert.deepEqual(await processes.status(app), [])
  console.log(`PASS: a Thread's app run started (${startMs} ms), was found with its ${report.pids.length} processes, named as port ${port}'s owner, and stopped with its tree (${Math.round(performance.now() - stopBegan)} ms) on ${process.platform}`)
} finally {
  await processes.stop(app).catch(() => undefined)
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
