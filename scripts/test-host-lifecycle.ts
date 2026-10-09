import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { hostLifecycle, nodeHostExit, stopOnSignals, takePredecessor, type HostStopReason, type StopFields } from "../electron/host-lifecycle.js"
import { acquireHostLock } from "../electron/host-lock.js"

const self = fileURLToPath(import.meta.url)
const role = process.argv[2]
if (role === "signals") await signalsChild(process.argv[3]!)
else if (role === "host") await hostChild(process.argv[3]!, process.argv[4]!)
else await check()

/** A host that stops on signals; its cleanup takes a while and leaves a mark. */
async function signalsChild(marks: string) {
  const lifecycle = hostLifecycle({
    cleanup: async () => {
      await new Promise((done) => setTimeout(done, 400))
      await appendFile(marks, "cleaned\n")
    },
    exit: (code) => process.exit(code),
    log() {},
    failed: async () => {},
  })
  stopOnSignals(lifecycle)
  console.log("ready")
  setInterval(() => {}, 1000)
}

/** A plain Node host on a data root: it records itself, and restarts on SIGUSR2. */
async function hostChild(dataRoot: string, records: string) {
  const predecessor = takePredecessor()
  const lock = await acquireHostLock(dataRoot, { predecessor })
  await appendFile(records, `${JSON.stringify({ pid: process.pid, lock: lock.kind, predecessor: predecessor ?? null, inherited: process.env.MAKO_HOST_SUCCEEDS ?? null })}\n`)
  if (lock.kind !== "held") process.exit(1)
  const lifecycle = hostLifecycle({
    cleanup: () => new Promise((done) => setTimeout(done, 200)),
    exit: nodeHostExit(),
    log() {},
    failed: async () => {},
  })
  process.on("SIGUSR2", () => void lifecycle.stop({ kind: "request", action: "restart" }))
  setInterval(() => {}, 1000)
}

async function rules() {
  const tick = () => new Promise<void>((done) => setImmediate(done))
  const exits: Array<[number, boolean]> = []
  const logs: Array<[string, StopFields]> = []
  let cleaned = 0
  let release!: () => void
  const lifecycle = hostLifecycle({
    cleanup: () => {
      cleaned++
      return new Promise<void>((done) => { release = done })
    },
    exit: (code, restart) => { exits.push([code, restart]) },
    log: (message, fields) => { logs.push([message, fields]) },
    failed: async () => {},
  })
  assert.deepEqual(lifecycle.state(), { kind: "running" })
  const first = lifecycle.stop({ kind: "signal", signal: "SIGTERM" })
  assert.equal(lifecycle.state().kind, "stopping", "Stopping is visible at once")
  await Promise.resolve()
  assert.equal(cleaned, 0, "Cleanup waits until the caller's turn is over, so its answer goes out first")
  await tick()
  assert.equal(cleaned, 1)
  const second = lifecycle.stop({ kind: "request", action: "restart" })
  assert.equal(second, first, "A later stop joins the first")
  release()
  await first
  assert.equal(cleaned, 1, "Cleanup runs once")
  assert.deepEqual(exits, [[0, false]], "The first reason decides; a restart asked for during a stop isn't one")
  assert.deepEqual(lifecycle.state(), { kind: "stopped", reason: { kind: "signal", signal: "SIGTERM" }, code: 0 })
  assert.deepEqual(logs, [["stopping", { signal: "SIGTERM" }]])

  const outcome = async (reason: HostStopReason, fail = false) => {
    const seen: string[] = []
    const one = hostLifecycle({
      cleanup: async () => { if (fail) throw new Error("store would not close") },
      exit: (code, restart) => { seen.push(`exit ${code} ${restart}`) },
      log() {},
      failed: async (error) => {
        await new Promise((done) => setTimeout(done, 20))
        seen.push(`failed ${error.message}`)
      },
    })
    await one.stop(reason)
    return seen
  }
  assert.deepEqual(await outcome({ kind: "request", action: "restart" }), ["exit 0 true"], "A restart asks for a successor")
  assert.deepEqual(await outcome({ kind: "request", action: "install" }), ["exit 0 false"])
  assert.deepEqual(await outcome({ kind: "idle" }), ["exit 0 false"])
  assert.deepEqual(
    await outcome({ kind: "request", action: "restart" }, true),
    ["failed store would not close", "exit 1 false"],
    "A failed cleanup is recorded before the process ends with 1, and no successor starts on it"
  )
}

async function signals(root: string) {
  const run = async (twice: boolean) => {
    const marks = join(root, `marks-${twice}`)
    const child = spawn(process.execPath, [...process.execArgv, self, "signals", marks], { stdio: ["ignore", "pipe", "inherit"] })
    const exited = once(child, "exit")
    await once(child.stdout, "data")
    child.kill("SIGTERM")
    if (twice) {
      await new Promise((done) => setTimeout(done, 100))
      child.kill("SIGTERM")
    }
    const [code, signal] = await exited
    const cleaned = await readFile(marks, "utf8").then((text) => text.includes("cleaned"), () => false)
    return { code, signal, cleaned }
  }
  assert.deepEqual(await run(false), { code: 0, signal: null, cleaned: true }, "SIGTERM stops the host through its cleanup")
  assert.deepEqual(await run(true), { code: null, signal: "SIGTERM", cleaned: false }, "A second SIGTERM ends it at once")
}

async function restart(root: string) {
  const dataRoot = join(root, "data")
  const records = join(root, "records")
  const read = async () => (await readFile(records, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line))
  const until = async (count: number) => {
    const deadline = Date.now() + 20_000
    for (;;) {
      const lines = await read()
      if (lines.length >= count) return lines
      assert.ok(Date.now() < deadline, `${count} host records appeared`)
      await new Promise((done) => setTimeout(done, 50))
    }
  }
  const first = spawn(process.execPath, [...process.execArgv, self, "host", dataRoot, records], { stdio: "ignore" })
  const exited = once(first, "exit")
  let successor: number | undefined
  try {
    await until(1)
    first.kill("SIGUSR2")
    const [code] = await exited
    assert.equal(code, 0, "The restarted host exits cleanly")
    const [before, after] = await until(2)
    successor = after.pid
    assert.deepEqual(before, { pid: first.pid, lock: "held", predecessor: null, inherited: null })
    assert.deepEqual(after, { pid: after.pid, lock: "held", predecessor: first.pid, inherited: null },
      "The successor waits for its predecessor's lock, takes it, and keeps the handoff from its own children")
    assert.notEqual(after.pid, first.pid)
  } finally {
    first.kill("SIGKILL")
    if (successor) try { process.kill(successor, "SIGKILL") } catch { /* gone */ }
  }
}

async function check() {
  const root = await mkdtemp(join(tmpdir(), "mako-host-lifecycle-"))
  try {
    await rules()
    await signals(root)
    await restart(root)
    console.log("Host lifecycle: one stop for every reason, cleanup once and after the caller's answer, failures recorded then exit 1, signals stop then kill, a plain Node restart hands its lock to a successor")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
