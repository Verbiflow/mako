import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { localRuntime } from "./install-local-mac.mjs"
import { readLocalAppMetadata } from "./local-app-metadata.mjs"
import { invokeRuntime } from "../dist-electron/runtime-connection.js"
import { startCocoaFixture } from "./lib/cocoa-fixture.mjs"
import { sampleFrontmost } from "./lib/control-fixture.mjs"

// Opt-in paid provider acceptance through the user's running installed host.
// Only this script's conversation and disposable AppKit window are changed.
const provider = process.argv[2]
const model = process.argv[3]
assert.ok(provider && model, "Use test-installed-control-agent.mjs <provider> <model>")
const root = await mkdtemp(join(tmpdir(), "mako-installed-control-agent-"))
const runtime = await localRuntime()
assert.ok(runtime.host, "Start installed Mako first")
const client = randomUUID(), id = randomUUID()
const call = (channel, ...args) => invokeRuntime(runtime.socket, client, channel, args)
const expected = readLocalAppMetadata("/Applications/Mako.app").makoBuild
assert.equal((await call("mako:installation-state")).build?.id, expected.id)
const descriptors = await call("mako:harness-descriptors")
const descriptor = descriptors.find(item => item.provider === provider)
const fullAccess = descriptor?.modes.find(mode => mode.access === "full")
assert.ok(fullAccess, "Provider must declare a full-access mode for this disposable test")
const report = { provider, model, build: expected, conversation: id, root, status: "running", turns: [] }
console.log(JSON.stringify({ stage: "starting", conversation: id, root, provider, model }))
let fixture, sampler, started = false
const snapshot = () => call("mako:live-snapshot", id)
async function until(read, done, label, timeout = 240000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await read()
    if (done(result)) return result
    await delay(250)
  }
  throw new Error(`Timed out: ${label}`)
}
async function prompt(text, value) {
  const request = randomUUID(), began = Date.now()
  await call("mako:live-prompt", id, request, text)
  const completed = await until(snapshot, state => {
    const item = state.requests.find(item => item.id === request)
    if (item && ["failed", "cancelled", "interrupted"].includes(item.status))
      throw new Error(`Fixture turn ${item.status}`)
    if (state.session.status === "error") throw new Error(state.session.error ?? "Provider failed")
    return item?.status === "completed"
  }, "provider fixture turn")
  const state = await fixture.state()
  assert.equal(state.input, value)
  assert.equal(state.value, value)
  const tools = completed.blocks.filter(block => block.type === "tool")
  const mcp = tools.filter(block => /mako.control.*\bjs\b/i.test(block.title ?? ""))
  assert.ok(mcp.length, "The provider must actually invoke Mako Control MCP")
  report.turns.push({ request, elapsedMs: Date.now() - began, exactValue: true,
    cumulativeMcpCalls: mcp.length, nativeId: completed.session.nativeId,
    documentationResults: mcp.filter(block => /Mako browser and computer use/.test(block.output ?? "")).length })
  console.log(JSON.stringify({ stage: "turn-passed", ...report.turns.at(-1) }))
  return completed
}
try {
  const title = `Mako installed recovery ${id.slice(0, 8)}`
  fixture = await startCocoaFixture({ root, title })
  const { pid } = await fixture.started()
  sampler = sampleFrontmost()
  await call("mako:live-start", provider, root, { conversationId: id,
    title: "Disposable installed control acceptance", modeId: fullAccess.id, tuning: { model } })
  started = true
  await until(snapshot, state => {
    if (["error", "failed", "closed"].includes(state?.session.status))
      throw new Error(state.session.error ?? `Provider startup ${state.session.status}`)
    return state?.session.status === "ready"
  }, "provider ready", 60000)
  const first = `  Before ${randomUUID()} Zoë 🧪 00123  `
  const initial = await prompt(`Operate the background native window titled ${JSON.stringify(title)}, pid ${pid}. Replace its Proof field with this exact JSON string, including surrounding spaces: ${JSON.stringify(first)}. Press Verify proof and check the Result. Keep the window in the background. This is an authorized disposable UI test; do not edit fixture files or use its status file as a substitute for UI verification. Reply done when verified.`, first)
  const compactId = randomUUID()
  await call("mako:live-action", id, { kind: "compact", id: compactId })
  const compacted = await until(snapshot, state => {
    const action = state.control.actions?.find(action => action.input.id === compactId)
    if (action && ["failed", "uncertain", "not-accepted"].includes(action.state.kind))
      throw new Error(`Compaction ${action.state.kind}: ${action.state.reason}`)
    return action?.state.kind === "completed"
  }, "provider-confirmed compaction", 310000)
  assert.equal(compacted.session.nativeId, initial.session.nativeId)
  report.compaction = { confirmed: true, nativeSessionRetained: true }
  console.log(JSON.stringify({ stage: "compaction-confirmed" }))
  const second = `  After ${randomUUID()} Renée é 00123  `
  const resumed = await prompt(`Continue editing the same background native window. Set Proof to this exact JSON string including surrounding spaces: ${JSON.stringify(second)}. Press Verify proof and check the Result. Keep the window in the background; reply done when verified.`, second)
  assert.equal(resumed.session.nativeId, initial.session.nativeId)
  assert.ok(report.turns[1].cumulativeMcpCalls > report.turns[0].cumulativeMcpCalls,
    "The post-compaction task must make new MCP calls")
  assert.ok(report.turns[1].documentationResults > report.turns[0].documentationResults,
    "The post-compaction task must restore the SDK documentation")

  const interruptedValue = `  Interrupted ${randomUUID()}  `
  const interruptedRequest = randomUUID()
  await call("mako:live-prompt", id, interruptedRequest,
    `In the same background window set Proof to ${JSON.stringify(interruptedValue)}. Then wait 30 seconds before pressing Verify proof. This controlled delay lets the test cancel you after the edit has landed. Do not use fixture files. Keep the window in the background.`)
  await fixture.until(async () => (await fixture.state()).input === interruptedValue,
    "provider's pre-cancellation edit", 120000)
  assert.equal((await fixture.state()).value, second, "Verification happened before cancellation")
  await call("mako:live-cancel", id)
  await until(snapshot, state => state.requests.some(request => request.id === interruptedRequest &&
    ["cancelled", "interrupted"].includes(request.status)), "provider cancellation", 30000)
  // Wait beyond the agent's requested delay; a stopped continuation must not
  // press Verify proof after the task has been cancelled.
  await delay(31000)
  assert.equal((await fixture.state()).input, interruptedValue)
  assert.equal((await fixture.state()).value, second)
  report.interruption = { inputLanded: true, delayedVerificationPrevented: true }
  console.log(JSON.stringify({ stage: "interruption-confirmed" }))
  const finalValue = `  Resumed ${randomUUID()} é 🧪  `
  const final = await prompt(`The previous task was cancelled after editing. Inspect the same background window before deciding what to do. Set Proof to ${JSON.stringify(finalValue)}, press Verify proof and check the Result. Do not repeat the interrupted task or its delay. Keep the window in the background.`, finalValue)
  assert.equal(final.session.nativeId, initial.session.nativeId)
  report.interruption.resumedExactValue = true
  const seen = await sampler.stop(); sampler = undefined
  assert.ok(seen.size, "Foreground sampling must return evidence")
  assert.ok(!seen.has(pid), "The native fixture took the foreground")
  report.native = { exactValues: true, targetFronted: false, foregroundSamples: [...seen.values()].reduce((a, b) => a + b, 0) }
  report.status = "passed"
} catch (error) {
  report.status = "failed"
  report.error = error.message
  process.exitCode = 1
} finally {
  await sampler?.stop()
  if (started) await call("mako:live-close", id).catch(error => {
    report.cleanupError = error.message; report.status = "failed"; process.exitCode = 1
  })
  fixture?.stop()
  await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(report))
}
