import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { truncateSync } from "node:fs"
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { acquireSuccessorLock, hostLifecycle, nodeHostExit, stopOnSignals, SUCCEEDS_ENV, takePredecessor, type HostStopReason, type StopFields, type SuccessorLockOptions } from "@mako/host/base/host-lifecycle"
import { acquireHostLock, hostLockName } from "@mako/host/base/host-lock"

const self = fileURLToPath(import.meta.url)
const role = process.argv[2]
if (role === "signals") await signalsChild(process.argv[3]!)
else if (role === "host") await hostChild(process.argv[3]!, process.argv[4]!)
else if (role === "stuck-host") await hostChild(process.argv[3]!, process.argv[4]!, true)
else if (role === "holder") await holderChild(process.argv[3]!, process.argv[4]!)
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

/** Its main thread stopped for good, as a host stuck in its exit is: nothing runs, not even a signal's listener. */
function stopForever(): never {
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}

/**
 * Holds a data root's lock. `stuck` answers no signal but SIGKILL; `silent` is stuck and names nobody as the holder, as
 * any stuck holder on Linux does, where the lock answers from the main thread; `answers` ends on SIGTERM.
 */
async function holderChild(dataRoot: string, behaviour: string) {
  await acquireHostLock(dataRoot)
  if (behaviour === "silent" && process.platform === "darwin") truncateSync(hostLockName(dataRoot))
  if (behaviour !== "answers") process.on("SIGTERM", () => undefined)
  console.log("ready")
  if (behaviour !== "answers") stopForever()
  setInterval(() => {}, 1000)
}

/** A plain Node host on a data root: it records itself, and restarts on SIGUSR2, stuck in its exit if asked. */
async function hostChild(dataRoot: string, records: string, stuckExit = false) {
  const predecessor = takePredecessor()
  const ends: unknown[] = []
  const lock = await acquireSuccessorLock(dataRoot, predecessor, { log: (message, fields) => ends.push({ message, fields }), waitMs: stuckExit ? 500 : undefined })
  const record = () => appendFile(records, `${JSON.stringify({ pid: process.pid, lock: lock.kind, predecessor: predecessor ?? null, ends, inherited: process.env.MAKO_HOST_SUCCEEDS ?? null })}\n`)
  if (lock.kind !== "held") {
    await record()
    process.exit(1)
  }
  const lifecycle = hostLifecycle({
    cleanup: () => new Promise((done) => setTimeout(done, 200)),
    exit: nodeHostExit(),
    log() {},
    failed: async () => {},
  })
  process.on("SIGUSR2", () => void lifecycle.stop({ kind: "request", action: "restart" }))
  if (stuckExit && !predecessor) {
    process.on("SIGTERM", () => undefined)
    process.on("exit", stopForever)
  }
  setInterval(() => {}, 1000)
  // The record is the test's cue to signal: written before the handler, a loaded machine's SIGUSR2 could land first
  // and end the process by its default action.
  await record()
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
  assert.deepEqual(await outcome({ kind: "failed", error: "No domain declares mako:usage" }), ["exit 1 false"], "A host that couldn't start ends with 1 after its cleanup")
  assert.deepEqual(
    await outcome({ kind: "request", action: "restart" }, true),
    ["failed store would not close", "exit 1 false"],
    "A failed cleanup is recorded before the process ends with 1, and no successor starts on it"
  )
}

function handover() {
  const taken = (value?: string) => {
    const env: NodeJS.ProcessEnv = value === undefined ? {} : { [SUCCEEDS_ENV]: value }
    const predecessor = takePredecessor(env)
    assert.equal(env[SUCCEEDS_ENV], undefined, "Read once, and kept from the host's children")
    return predecessor
  }
  assert.equal(taken("123"), 123)
  for (const nonsense of [undefined, "", "0", "-1", "soon", "12.5", "123:x", "99999999999999999999"]) assert.equal(taken(nonsense), undefined, `Not a predecessor: ${nonsense}`)
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
    assert.deepEqual(before, { pid: first.pid, lock: "held", predecessor: null, ends: [], inherited: null })
    assert.deepEqual(after, { pid: after.pid, lock: "held", predecessor: first.pid, ends: [], inherited: null },
      "The successor waits for its predecessor's lock, takes it, and keeps the handoff from its own children")
    assert.notEqual(after.pid, first.pid)
  } finally {
    first.kill("SIGKILL")
    if (successor) try { process.kill(successor, "SIGKILL") } catch { /* gone */ }
  }
}

/**
 * A successor ends only the stuck process that named itself, while it's the successor's parent, and says so when it
 * can't. Here each holder is this test's child, so it stands in as the parent (`parent`); `stuckRestart` is the real one.
 */
async function stuckPredecessor(root: string) {
  let held = 0
  // A stuck holder never ends by itself, so a failed assertion mustn't leave one running.
  const children: ChildProcess[] = []
  const holding = async (behaviour: "stuck" | "silent" | "answers", dataRoot: string) => {
    const child = spawn(process.execPath, [...process.execArgv, self, "holder", dataRoot, behaviour], { stdio: ["ignore", "pipe", "inherit"] })
    children.push(child)
    const exited = once(child, "exit")
    await once(child.stdout, "data")
    return { pid: child.pid!, exited, stop: () => child.kill("SIGKILL"), alive: () => child.exitCode === null && child.signalCode === null }
  }
  const case_ = async (behaviour: "stuck" | "silent" | "answers", overrides: (holder: number) => Partial<SuccessorLockOptions> = () => ({})) => {
    const dataRoot = join(root, `stuck-${held++}`)
    const holder = await holding(behaviour, dataRoot)
    const logged: Array<{ message: string; signal: unknown; why: unknown }> = []
    const lock = await acquireSuccessorLock(dataRoot, holder.pid, {
      log: (message, fields) => logged.push({ message, signal: fields.signal, why: fields.why }),
      waitMs: 100, answerMs: { SIGTERM: 500, SIGKILL: 15_000 }, parent: () => holder.pid, ...overrides(holder.pid),
    })
    return { lock, logged, holder, dataRoot }
  }
  const finish = async (lock: Awaited<ReturnType<typeof acquireSuccessorLock>>) => { if (lock.kind === "held") await lock.release() }
  try {

    {
      const { lock, logged, holder } = await case_("stuck")
      assert.equal(lock.kind, "held", "The stuck holder ended, its lock is the successor's")
      assert.deepEqual(await holder.exited, [null, "SIGKILL"], "A stuck process answers only SIGKILL")
      assert.deepEqual(logged.map((each) => each.signal), ["SIGTERM", "SIGKILL", "SIGKILL"], "Each signal logged, then the one that ended it")
      assert.match(logged[0]!.message, /held the data root past its exit/, "The log says why")
      await finish(lock)
    }
    {
      const { lock, logged, holder } = await case_("answers")
      assert.equal(lock.kind, "held")
      assert.deepEqual(await holder.exited, [null, "SIGTERM"], "A process that can answer ends on SIGTERM")
      assert.deepEqual(logged.map((each) => each.signal), ["SIGTERM", "SIGTERM"], "SIGKILL is only for one that didn't")
      await finish(lock)
    }
    {
      const began = Date.now()
      let firstSignal = 0
      const { lock, logged, holder } = await case_("silent", () => ({
        waitMs: 1_500,
        signal: (pid, signal) => { firstSignal ||= Date.now(); process.kill(pid, signal) },
      }))
      assert.ok(firstSignal - began >= 1_500, `A holder that names nobody gets the whole wait first: ${firstSignal - began} ms`)
      assert.equal(lock.kind, "held", "A running predecessor is ended when the lock can't name its holder")
      assert.deepEqual(await holder.exited, [null, "SIGKILL"])
      assert.deepEqual(logged.map((each) => each.signal), ["SIGTERM", "SIGKILL", "SIGKILL"])
      await finish(lock)
    }
    const refused = async (label: string, run: Awaited<ReturnType<typeof case_>>, why: RegExp) => {
      assert.equal(run.lock.kind, "taken", label)
      assert.match("stuck" in run.lock ? run.lock.stuck : "", why, label)
      assert.ok(run.holder.alive(), `${label}: the process lives`)
      assert.match(String(run.logged.at(-1)?.why), why, `${label}: logged`)
      run.holder.stop()
      await run.holder.exited
    }
    let signalled = 0
    const counting = () => { signalled++ }
    // Not this process's parent, as this test isn't the holder's child: nothing says the pid is still that host's.
    const stranger = await case_("stuck", () => ({ signal: counting, parent: () => process.ppid }))
    assert.equal(signalled, 0, "A predecessor that isn't the parent is never signalled")
    await refused("A predecessor that isn't the parent", stranger, /isn't this host's parent.*kill -9 \d+/)

    // The same where the lock can't name its holder, as every stuck one on Linux: never signalled, and said, with the check.
    const silentStranger = await case_("silent", () => ({ signal: counting, parent: () => process.ppid }))
    assert.equal(signalled, 0, "A silent predecessor that isn't the parent is never signalled")
    await refused("A silent predecessor that isn't the parent", silentStranger, /isn't this host's parent.*ps -p \d+.*kill -9 \d+/)

    // Its parent went between the two signals, so the pid may be anyone's: read again before SIGKILL.
    const sent: string[] = []
    const orphaned = await case_("stuck", (holder) => ({
      signal: (_pid, signal) => void sent.push(signal),
      parent: () => (sent.length ? 1 : holder),
    }))
    assert.deepEqual(sent, ["SIGTERM"], "SIGKILL isn't sent once the predecessor is no longer the parent")
    await refused("A parent gone between signals", orphaned, /isn't this host's parent/)

    const denied = await case_("stuck", () => ({ signal: () => { throw new Error("kill EPERM") } }))
    await refused("A signal the system refuses", denied, /SIGTERM to pid \d+ failed \(kill EPERM\).*kill -9 \d+/)
    const unmoved = await case_("stuck", () => ({ signal: () => undefined, answerMs: { SIGTERM: 100, SIGKILL: 100 } }))
    await refused("A process SIGKILL didn't end", unmoved, /still holds the data root after SIGKILL.*kill -9 \d+/)

    // Another process holds the lock: the named one is no holder and nobody is signalled.
    const dataRoot = join(root, "someone-else")
    const other = await holding("answers", dataRoot)
    const bystander = await holding("answers", join(root, "bystander"))
    const notIt = await acquireSuccessorLock(dataRoot, bystander.pid, { log() {}, waitMs: 100, signal: counting, parent: () => bystander.pid })
    assert.deepEqual(notIt, { kind: "taken", holder: other.pid }, "A lock held by anyone but the predecessor is an ordinary refusal")
    assert.equal(signalled, 0, "and signals nobody")
    assert.ok(other.alive() && bystander.alive())
    other.stop()
    bystander.stop()
    await Promise.all([other.exited, bystander.exited])
  } finally {
    for (const child of children) child.kill("SIGKILL")
  }
}

/** The whole restart: a host stuck in its exit, its successor taking over from what `nodeHostExit` handed on. */
async function stuckRestart(root: string) {
  const dataRoot = join(root, "stuck-restart")
  const records = join(root, "stuck-records")
  const first = spawn(process.execPath, [...process.execArgv, self, "stuck-host", dataRoot, records], { stdio: "ignore" })
  const exited = once(first, "exit")
  let successor: number | undefined
  const until = async (count: number) => {
    for (const deadline = Date.now() + 60_000; ; await new Promise((done) => setTimeout(done, 50))) {
      const lines = (await readFile(records, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line))
      if (lines.length >= count) return lines
      assert.ok(Date.now() < deadline, `${count} host records appeared`)
    }
  }
  try {
    await until(1)
    first.kill("SIGUSR2")
    const [, after] = await until(2)
    successor = after.pid
    // The successor's record first: one that didn't end its parent leaves it stuck, and the exit below would never come.
    assert.equal(after.lock, "held", `The successor runs in its place: ${JSON.stringify(after.ends)}`)
    assert.equal(after.predecessor, first.pid)
    assert.deepEqual(after.ends.map((each: { fields: { signal: string } }) => each.fields.signal), ["SIGTERM", "SIGKILL", "SIGKILL"])
    assert.deepEqual(await exited, [null, "SIGKILL"], "The stuck host ended by SIGKILL, from its successor")
  } finally {
    first.kill("SIGKILL")
    if (successor) try { process.kill(successor, "SIGKILL") } catch { /* gone */ }
  }
}

async function check() {
  const root = await mkdtemp(join(tmpdir(), "mako-host-lifecycle-"))
  try {
    await rules()
    handover()
    await signals(root)
    await restart(root)
    await stuckPredecessor(root)
    await stuckRestart(root)
    console.log("Host lifecycle: one stop for every reason, cleanup once and after the caller's answer, failures recorded then exit 1, signals stop then kill, a plain Node restart hands its lock to a successor, and a successor ends only a predecessor proven stuck")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
