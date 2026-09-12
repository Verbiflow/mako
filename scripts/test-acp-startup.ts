import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { AcpStartupWatch, exitDescription, stderrDetail } from "../electron/acp-startup.ts"
import { errorMessage } from "../electron/live-runtime.ts"

class FakeProcess extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code
    this.signalCode = signal
    this.emit("exit", code, signal)
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// A step that answers within the silence window finishes and is reported.
{
  const child = new FakeProcess()
  const watch = new AcpStartupWatch(child, { harness: "grok", silenceMs: 200, totalMs: 2_000 })
  const value = await watch.step("initialize", Promise.resolve("ok"))
  assert.equal(value, "ok")
  assert.equal(watch.steps[0]?.name, "initialize")
  assert.equal(watch.steps[0]?.outcome, "done")
  assert.match(watch.summary(), /^initialize done \d+ms$/)
  watch.dispose()
}

// Silence fails the step and the message says what had already finished and
// that the process is still alive: the reader can tell "retry" from "broken".
{
  const child = new FakeProcess()
  const watch = new AcpStartupWatch(child, { harness: "grok", silenceMs: 120, totalMs: 5_000 })
  await watch.step("initialize", Promise.resolve(undefined))
  const never = new Promise<never>(() => {})
  await assert.rejects(
    watch.step("session/new", never),
    (error: Error) =>
      /^grok produced no output for 0\.[12] s during session\/new after finishing initialize \(process still running\)$/.test(error.message)
  )
  assert.deepEqual(watch.steps.map((step) => step.outcome), ["done", "silent"])
  watch.dispose()
}

// Output on either pipe pushes the deadline back: a provider that keeps
// connecting MCP servers one notification at a time is not a stalled one.
{
  const child = new FakeProcess()
  const watch = new AcpStartupWatch(child, { harness: "grok", silenceMs: 150, totalMs: 5_000 })
  const answer = Promise.withResolvers<string>()
  const pending = watch.step("session/new", answer.promise)
  const ticker = setInterval(() => child.stderr.emit("data", Buffer.from("mcp init 1/7\n")), 40)
  await sleep(450)
  clearInterval(ticker)
  answer.resolve("session")
  assert.equal(await pending, "session")
  assert.equal(watch.steps[0]?.outcome, "done")
  assert.ok((watch.steps[0]?.ms ?? 0) >= 400, "the step outlived three silence windows")
  watch.dispose()
}

// The hard cap still bounds a process that never answers but never goes quiet.
{
  const child = new FakeProcess()
  const watch = new AcpStartupWatch(child, { harness: "cursor", silenceMs: 200, totalMs: 300 })
  const ticker = setInterval(() => child.stdout.emit("data", Buffer.from("{}\n")), 30)
  await assert.rejects(
    watch.step("session/new", new Promise<never>(() => {})),
    /cursor did not finish session\/new within 0\.3 s \(its last stdout output was 0\.\d s ago\)$/
  )
  clearInterval(ticker)
  assert.equal(watch.steps[0]?.outcome, "timed-out")
  watch.dispose()
}

// An exit fails the step immediately, with the last meaningful stderr line.
{
  const child = new FakeProcess()
  let stderr = ""
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const watch = new AcpStartupWatch(child, { harness: "devin", silenceMs: 5_000, totalMs: 10_000, stderr: () => stderr })
  const pending = watch.step("initialize", new Promise<never>(() => {}))
  child.stderr.emit("data", Buffer.from("2026-09-11T21:13:42.000Z INFO booting\nError: no credentials found\n"))
  child.exit(1)
  await assert.rejects(pending, /devin exited with code 1 during initialize: Error: no credentials found$/)
  assert.equal(watch.steps[0]?.outcome, "exited")
  // A later step on a dead process fails before it is even sent.
  await assert.rejects(watch.step("session/new", Promise.resolve(1)), /devin exited with code 1 before session\/new: Error: no credentials found$/)
  watch.dispose()
}

// A work rejection is passed through unchanged, and steps do not overlap.
{
  const child = new FakeProcess()
  const watch = new AcpStartupWatch(child, { harness: "opencode", silenceMs: 500, totalMs: 1_000 })
  const held = watch.step("initialize", new Promise<never>(() => {}))
  await assert.rejects(watch.step("session/new", Promise.resolve(1)), /startup step initialize is still pending/)
  watch.dispose()
  await assert.rejects(held, /opencode startup was abandoned during initialize$/)
  await assert.rejects(watch.step("session/new", Promise.resolve(1)), /disposed before session\/new/)
  const fresh = new AcpStartupWatch(new FakeProcess(), { harness: "opencode", silenceMs: 500, totalMs: 1_000 })
  await assert.rejects(fresh.step("initialize", Promise.reject(new Error("auth_required"))), /^Error: auth_required$/)
  assert.equal(fresh.steps[0]?.outcome, "failed")
  fresh.dispose()
}

assert.equal(exitDescription(null, "SIGTERM"), "exited on SIGTERM")
assert.equal(exitDescription(2, null), "exited with code 2")
assert.equal(exitDescription(null, null), "exited")
assert.equal(stderrDetail("2026-09-11T21:13:42Z INFO started\n[31mfatal: bad[0m\n"), "fatal: bad")

// JSON-RPC errors keep their reason. "Invalid params" alone once explained
// two failed Cursor threads; the reason sat unread in `data.message`.
{
  const invalid = Object.assign(new Error("Invalid params"), { data: { message: "Unknown model config option: effort" } })
  assert.equal(errorMessage({ error: invalid }), "Invalid params: Unknown model config option: effort")
  const internal = Object.assign(new Error("Internal error"), { data: { details: "Invalid mode ID: access:full" } })
  assert.equal(errorMessage({ error: internal }), "Internal error: Invalid mode ID: access:full")
  const repeated = Object.assign(new Error("Invalid params: already said"), { data: { message: "already said" } })
  assert.equal(errorMessage({ error: repeated }), "Invalid params: already said")
  assert.equal(errorMessage({ error: new Error("plain") }), "plain")
  assert.equal(errorMessage({ error: "text" }), "text")
  assert.equal(errorMessage({ error: Object.assign(new Error(""), { data: { message: "only data" } }) }), "only data")
}

console.log(
  "ACP startup: silence, not a fixed budget, fails a step; output extends it; a hard cap and process exit still end it; JSON-RPC error data reaches the message"
)
