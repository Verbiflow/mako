import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { access, appendFile, cp, mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { ControlWorkers, startDesktopControlSession } from "../packages/control-runtime/dist/session.js"

/**
 * A task's Local Control session starts its worker at the first call, not at
 * launch: concurrent first calls share one worker; a loaded spare makes the
 * next task's first call fast and is refilled, then stopped when quiet; a
 * worker that can't start, or loaded newer code than its host, refuses every
 * waiting call as not dispatched; a session closed unused never starts one.
 */

const run = promisify(execFile)
const status = { method: "status" }
const signal = () => AbortSignal.timeout(20_000)
async function until(check, what, ms = 10_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    assert.ok(Date.now() < deadline, what)
    await delay(20)
  }
}
const gone = (path) => access(path).then(() => false, () => true)
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
async function timed(work) {
  const started = performance.now()
  await work
  return performance.now() - started
}

// Concurrent first calls, from this process and from the CLI: one worker.
{
  let spawned = 0
  const workers = new ControlWorkers({ spare: false, onSpawn: () => spawned++ })
  const session = await startDesktopControlSession({ taskId: "concurrent" }, { workers })
  assert.equal(spawned, 0, "a launch starts no worker")
  assert.equal(session.pid, undefined)
  const replies = await Promise.all([
    session.request(status, signal()),
    session.request(status, signal()),
    run(session.launch.command, ["status"]).then(({ stdout }) => JSON.parse(stdout)),
    run(session.launch.command, ["status"]).then(({ stdout }) => JSON.parse(stdout)),
  ])
  for (const reply of replies) assert.equal(reply.browser.configured, false)
  assert.equal(spawned, 1, "the calls waiting on the first start share its worker")
  assert.ok(session.pid)
  await session.request({ method: "js", code: "state.kept = 7", timeout_ms: 5000 }, signal())
  const exec = spawn(session.launch.command, ["exec", "--source-file", "-"], { stdio: ["pipe", "pipe", "inherit"] })
  let stdout = ""
  exec.stdout.on("data", (bytes) => (stdout += bytes))
  exec.stdin.end("return state.kept")
  assert.equal(await new Promise((done) => exec.once("close", done)), 0)
  assert.equal(JSON.parse(stdout).at(-1).value, 7, "the CLI and this process reach the same program")
  await session.close()
  assert.ok(await gone(session.launch.bin))
  await workers.close()
}

// The spare: loaded after the first task's start, taken by the next, refilled, stopped when quiet.
const numbers = {}
{
  const workers = new ControlWorkers({ quietMs: 1500 })
  const first = await startDesktopControlSession({ taskId: "cold" }, { workers })
  numbers.coldFirstCallMs = await timed(first.request(status, signal()))
  await until(() => workers.sparePid, "a spare is started once a task has used the computer")
  const spare = workers.sparePid
  await delay(600)
  const second = await startDesktopControlSession({ taskId: "warm" }, { workers })
  numbers.warmFirstCallMs = await timed(second.request(status, signal()))
  assert.equal(second.pid, spare, "the next task takes the spare")
  assert.ok(numbers.warmFirstCallMs < numbers.coldFirstCallMs / 2, JSON.stringify(numbers))
  await until(() => workers.sparePid && workers.sparePid !== spare, "the spare is refilled once taken")
  const refilled = workers.sparePid
  await until(() => workers.sparePid === undefined, "a quiet host stops its spare", 5000)
  await until(() => !alive(refilled), "the stopped spare's process exits")
  await first.close()
  await second.close()
  await workers.close()
}

// A worker that can't start: every waiting call is refused as not dispatched.
{
  const workers = new ControlWorkers({ spare: false, executable: "/nonexistent/mako-node" })
  const session = await startDesktopControlSession({ taskId: "broken" }, { workers })
  const outcomes = await Promise.allSettled([session.request(status, signal()), session.request(status, signal())])
  for (const outcome of outcomes) {
    assert.equal(outcome.status, "rejected")
    assert.ok(["session-start-failed", "session-closed"].includes(outcome.reason.code), outcome.reason.code)
    assert.equal(outcome.reason.outcome, "not-dispatched", "a call that waited on the start, or came after it failed, is refused, never left unknown")
  }
  assert.ok(outcomes.some((outcome) => outcome.reason.code === "session-start-failed"), "the call that started it learns why")
  assert.equal(await session.exited, "failed")
  assert.ok(await gone(session.launch.bin))
}

// Closed before its first call: no worker, no files.
{
  let spawned = 0
  const workers = new ControlWorkers({ spare: false, onSpawn: () => spawned++ })
  const session = await startDesktopControlSession({ taskId: "unused" }, { workers })
  await session.close()
  assert.equal(await session.exited, "stopped")
  assert.equal(spawned, 0)
  assert.ok(await gone(session.launch.bin))
  assert.throws(() => session.request(status, signal()), { code: "session-closed" })
}

// A host older than the code on disk: the worker loads the newer code, so it's refused.
{
  const root = resolve("node_modules/.cache")
  const copy = await mkdtemp(join(root, "mako-control-stale-"))
  try {
    await cp(resolve("packages/control-runtime/dist"), join(copy, "dist"), { recursive: true })
    await cp(resolve("packages/control-runtime/package.json"), join(copy, "package.json"))
    const stale = await import(pathToFileURL(join(copy, "dist/session.js")).href)
    const workers = new stale.ControlWorkers({ spare: false })
    const session = await stale.startDesktopControlSession({ taskId: "stale" }, { workers })
    await appendFile(join(copy, "dist/json.js"), "\n// changed on disk after the host loaded\n")
    await assert.rejects(session.request(status, signal()), (error) =>
      error.code === "incompatible-session" && error.outcome === "not-dispatched" && /Restart Mako/.test(error.message))
    assert.equal(workers.stale, true, "the host knows new tasks can't use the code on disk")
    assert.equal(await session.exited, "failed")
    await workers.close()
  } finally {
    await rm(copy, { recursive: true, force: true })
  }
}

console.log(JSON.stringify(numbers))
console.log("Control activation: no worker until the first call, one for concurrent first calls; a spare taken, refilled and stopped when quiet; a failed or stale start refuses every waiting call as not dispatched; a session closed unused starts none")
