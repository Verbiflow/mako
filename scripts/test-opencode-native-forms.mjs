import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { startOpenCodeApi } from "../electron/providers/opencode/native-api.ts"
import { ProviderLaunchTrace } from "../electron/provider-launch.ts"

// Native contract probe. All stores and sessions are disposable; no model call,
// user configuration mutation, saved answer replay or patched runtime.
const root = await mkdtemp(join(tmpdir(), "mako-opencode-forms-"))
const executable = process.env.OPENCODE_BIN_PATH ?? join(homedir(), ".opencode/bin/opencode2")
const env = { ...process.env, OPENCODE_CONFIG_CONTENT: "{}" }
for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "OPENCODE_CONFIG_DIR"]) {
  env[name] = join(root, name)
  await mkdir(env[name], { recursive: true })
}
const stop = new AbortController()
const deadline = setTimeout(() => stop.abort(new Error("Native form probe exceeded 60 seconds")), 60_000)
let client
let runtime
let loseReply = false
let replyRequests = 0
const phases = []
const sessions = []
const events = []
let reader
let eventStop = new AbortController()
const report = { sdk: "@opencode/client@2.0.1", passed: false, cases: [], events: [], cleanup: false }
const request = () => ({ signal: stop.signal })
const open = () => startOpenCodeApi({ command: executable, cwd: root, env, conversationId: "native-form-probe",
    signal: stop.signal,
    trace: new ProviderLaunchTrace({ provider: "opencode", conversation: "native-form-probe" }, { report: phase => phases.push(phase) }),
    fetch: async (input, init) => {
      if (String(input).endsWith("/reply")) replyRequests++
      const response = await fetch(input, init)
      if (loseReply && String(input).endsWith("/reply") && response.ok) {
        loseReply = false
        await response.arrayBuffer()
        throw new Error("Injected response loss after native consumption")
      }
      return response
    },
  })
const subscribe = async () => {
  eventStop = new AbortController()
  const iterator = client.event.subscribe({ signal: AbortSignal.any([stop.signal, eventStop.signal]) })[Symbol.asyncIterator]()
  const connected = await iterator.next()
  assert.equal(connected.value?.type, "server.connected")
  reader = (async () => {
    try {
      for (;;) {
        const next = await iterator.next()
        if (next.done) break
        events.push(next.value)
      }
    } finally { await iterator.return?.() }
  })()
  reader.catch(() => {})
}
try {
  runtime = await open()
  client = runtime.client
  report.health = runtime.health
  await subscribe()
  for (let i = 0; i < 2; i++) sessions.push(await client.session.create({ title: `Mako disposable form probe ${i}`, location: { directory: root } }, request()))
  const sessionID = sessions[0].id
  const fields = [
    { key: "single", type: "string", title: "Pick one", required: true, options: [{ value: "a", label: "First" }, { value: "b", label: "Second" }] },
    { key: "multiple", type: "multiselect", title: "Pick several", custom: true, options: [{ value: "x", label: "X" }] },
  ]
  const first = await client.form.create({ sessionID, title: "Native structured question", fields }, request())
  const identity = { sessionID, formID: first.id }
  assert.deepEqual(await client.form.state(identity, request()), { status: "pending" })
  await assert.rejects(client.form.reply({ ...identity, answer: { single: "not-an-option" } }, request()))
  assert.deepEqual(await client.form.state(identity, request()), { status: "pending" })
  report.cases.push("native invalid-answer rejection preserves pending form")
  await assert.rejects(client.form.state({ ...identity, sessionID: sessions[1].id }, request()))
  report.cases.push("wrong-session form lookup rejected")
  const answer = { single: "b", multiple: ["x", "custom answer"] }
  // Lose both observation and the reply response. Catch-up must read native
  // state without submitting the saved answer again.
  eventStop.abort()
  await reader
  const before = replyRequests
  loseReply = true
  await assert.rejects(client.form.reply({ ...identity, answer }, request()))
  await subscribe()
  assert.deepEqual(await client.form.state(identity, request()), { status: "answered", answer })
  assert.equal(replyRequests, before + 1)
  assert.ok(!events.some(event => event.type === "form.replied" && event.data.id === first.id))
  report.cases.push("lost reply reconciles exact native answer without resubmission")
  await assert.rejects(client.form.reply({ ...identity, answer: { single: "a" } }, request()))
  assert.deepEqual(await client.form.state(identity, request()), { status: "answered", answer })
  report.cases.push("second answer cannot overwrite the consumed answer")
  const newer = await client.form.create({ sessionID, title: "Newer question", fields }, request())
  assert.deepEqual(await client.form.state({ sessionID, formID: newer.id }, request()), { status: "pending" })
  assert.deepEqual(await client.form.state(identity, request()), { status: "answered", answer })
  assert.deepEqual(await client.form.state({ sessionID, formID: newer.id }, request()), { status: "pending" })
  await client.form.cancel({ sessionID, formID: newer.id }, request())
  assert.deepEqual(await client.form.state({ sessionID, formID: newer.id }, request()), { status: "cancelled" })
  assert.deepEqual(await client.form.state(identity, request()), { status: "answered", answer })
  report.cases.push("old evidence and newer cancellation preserve distinct form state")
  const observed = await client.form.create({ sessionID, title: "Observed answer", fields }, request())
  await client.form.reply({ sessionID, formID: observed.id, answer }, request())
  assert.deepEqual(await client.form.state({ sessionID, formID: observed.id }, request()), { status: "answered", answer })
  report.events = events.filter(event => event.type.startsWith("form.")).map(event => ({ type: event.type, data: event.data }))
  assert.ok(report.events.some(event => event.type === "form.created" && event.data.form.id === first.id))
  assert.ok(report.events.some(event => event.type === "form.replied" && event.data.id === observed.id))
  report.cases.push("native SDK receives created and replied events")
  const pending = await client.form.create({ sessionID, title: "Pending at server shutdown", fields }, request())
  eventStop.abort()
  await reader
  const oldClient = client
  const oldPid = runtime.health.pid
  await runtime.close()
  await runtime.close()
  assert.throws(() => process.kill(oldPid, 0), { code: "ESRCH" })
  await assert.rejects(oldClient.form.state(identity, request()))
  runtime = await open()
  client = runtime.client
  assert.equal((await client.session.get({ sessionID }, request())).id, sessionID)
  await assert.rejects(client.form.state(identity, request()))
  await assert.rejects(client.form.state({ sessionID, formID: pending.id }, request()))
  report.cases.push("server restart preserves session but loses in-memory forms; retained evidence is required")
  report.passed = true
} finally {
  try {
    if (client) for (const session of sessions) await client.session.remove({ sessionID: session.id }, { signal: AbortSignal.timeout(5000) })
  } finally {
    stop.abort()
    await reader?.catch(() => {})
    await runtime?.close()
    await runtime?.close()
    clearTimeout(deadline)
    if (runtime) assert.throws(() => process.kill(runtime.health.pid, 0), { code: "ESRCH" })
    report.cleanup = true
    report.phases = phases
    await rm(root, { recursive: true, force: true })
    if (process.env.MAKO_PROOF_OUTPUT) await writeFile(process.env.MAKO_PROOF_OUTPUT, JSON.stringify(report, null, 2) + "\n")
  }
}
console.log(JSON.stringify(report, null, 2))
