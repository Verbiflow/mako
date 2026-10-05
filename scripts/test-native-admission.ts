import assert from "node:assert/strict"
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { abortNative, nativeStopToken, bindDrivers, resumeNative, waitForNativeRun, threadRun, nativeLifecycleWork } from "../electron/drivers.ts"
import { providerHost } from "../electron/providers/index.ts"
import { SessionMemory } from "../electron/session-memory.ts"
import type { ResumeVerdict } from "../electron/contracts/conversation-control.ts"
import type { ThreadRef } from "@mako/sessions"
import { ExecutionContextSchema } from "../electron/contracts/execution-context.ts"

const root = await mkdtemp(join(tmpdir(), "mako-native-admission-"))
const provider = "native-admission-fixture"
const ref: ThreadRef = { harness: provider, nativeId: "native-fixture", path: join(root, "session"), cwd: root }
const memory = new SessionMemory(join(root, "memory.sqlite"), { pid: process.pid, startedAt: Date.now(), label: "native admission fixture" })
let prepareGate = Promise.resolve()
let preparations = 0
let claims = 0
let releases = 0
let verdict: ResumeVerdict = { kind: "held", by: "external executor" }
let pipeDescendant = false
let resolutions = 0
let credential = "admitted-fixture-credential"
let refuseCredential = false
let prepareStarted = () => {}
const unregister = providerHost.nativeRunners.register({
  provider, transport: "fixture-headless", available: () => true, fastMode: "unsupported", carries: [],
  launchCredentials: { kind: "resolved", resolve: async env => {
    resolutions++
    if (refuseCredential) throw new Error("Fixture credential unavailable")
    return { env: { ...env, NATIVE_FIXTURE_CREDENTIAL: credential }, credential: { kind: "configured", source: "fixture-record", revision: { kind: "reported", value: "fixture-revision", via: "fixture record" } } }
  } },
  prepare: async (options, env) => { preparations++; assert.equal(env.NATIVE_FIXTURE_CREDENTIAL, "admitted-fixture-credential"); prepareStarted(); await prepareGate; return { options, dropped: [] } },
  resume: (_id, _prompt, _options, env) => {
    assert.equal(env?.NATIVE_FIXTURE_CREDENTIAL, "admitted-fixture-credential", "command construction retains the prepared credential snapshot")
    return { command: process.execPath, args: pipeDescendant
    ? [fileURLToPath(new URL("./fixtures/native-pipe-child.mjs", import.meta.url)), "leader", root]
    : ["-e", "if (process.env.NATIVE_FIXTURE_CREDENTIAL !== 'admitted-fixture-credential') process.exit(1); console.log('own-native-fixture'); setTimeout(() => {}, 40)"] }
  },
  fresh: () => { throw new Error("Recovery must not fall back to a fresh session") },
  describe: () => ({}),
})
const claim = () => {
  const id = randomUUID()
  memory.hold(provider, ref.nativeId, id)
  claims++
  return () => { releases++; memory.release(provider, ref.nativeId, id) }
}
try {
  bindDrivers(() => {}, { assessResume: async () => verdict, claimSession: claim })
  await assert.rejects(resumeNative(ref, "must not dispatch"), /external executor/)
  assert.equal(threadRun(ref.path), null)
  assert.equal(claims, 0, "an external owner refuses before a local claim or spawn")
  bindDrivers(() => {})
  await assert.rejects(resumeNative(ref, "missing assessment"), /cannot be resumed/)
  assert.equal(nativeLifecycleWork().length, 0, "refused preparation releases the reservation")

  verdict = { kind: "resumable", record: "unknown" }
  bindDrivers(() => {}, { assessResume: async () => verdict })
  await assert.rejects(resumeNative(ref, "missing claim"), /ownership is unavailable/)
  const gate = Promise.withResolvers<void>()
  prepareGate = gate.promise
  bindDrivers(() => {}, { assessResume: async () => verdict, claimSession: claim })
  const before = preparations
  const first = resumeNative(ref, "one request", { captureOutput: true })
  await assert.rejects(resumeNative(ref, "concurrent request", { captureOutput: true }), /preparing writer/)
  credential = "later-fixture-selection"
  gate.resolve()
  const launched = await first
  const context = ExecutionContextSchema.parse(launched.executionContext)
  assert.equal(context.transport, "fixture-headless")
  assert.equal(context.identity.kind, "unavailable", "configured credentials do not prove a native identity")
  assert.equal(context.runtime.kind, "unavailable", "the host version is not the native runtime version")
  assert.equal(context.service?.kind, "unavailable")
  assert.equal(context.store.kind, "unavailable", "a requested session path is not a located native store")
  assert.equal(context.credential?.kind, "configured")
  assert.ok(!JSON.stringify(context).includes("admitted-fixture-credential"), "public state excludes private environment values")
  assert.equal(preparations, before + 1, "only the winning request prepares the native command")
  assert.equal(claims, 1)
  const output = await waitForNativeRun(ref.path)
  assert.equal(output.state.status, "done")
  assert.deepEqual(output.state.executionContext, context, "settlement retains this launch's public facts")
  assert.equal(output.text.trim(), "own-native-fixture")
  assert.equal(releases, 1, "settlement releases the exact cooperating-host claim once")
  credential = "admitted-fixture-credential"
  const resolvedBefore = resolutions
  refuseCredential = true
  await assert.rejects(resumeNative(ref, "unreadable credential"), /Fixture credential unavailable/)
  assert.equal(resolutions, resolvedBefore + 1)
  assert.equal(claims, 1, "failed credential resolution cannot claim or spawn a different identity")
  assert.equal(nativeLifecycleWork().length, 0)
  refuseCredential = false

  const cancelled = Promise.withResolvers<void>()
  const preparing = Promise.withResolvers<void>()
  prepareGate = cancelled.promise
  prepareStarted = () => preparing.resolve()
  const cancelledStart = resumeNative(ref, "Stop during preparation", { captureOutput: true })
  const cancelledResult = assert.rejects(cancelledStart, /startup was cancelled/)
  await preparing.promise
  const oldToken = nativeStopToken(ref.path)
  assert.ok(oldToken)
  assert.equal(nativeLifecycleWork()[0]?.stoppable, true)
  assert.equal(nativeLifecycleWork()[0]?.id, `native:${ref.path}`, "application Stop routes preparation through the same native owner")
  abortNative(ref.path, oldToken)
  cancelled.resolve()
  await cancelledResult
  assert.equal(claims, 1, "startup cancellation precedes ownership claim and native spawn")
  assert.equal(nativeLifecycleWork().length, 0, "cancelled preparation drains its reservation")
  const replacement = Promise.withResolvers<void>()
  const replacing = Promise.withResolvers<void>()
  prepareGate = replacement.promise
  prepareStarted = () => replacing.resolve()
  const replacementStart = resumeNative(ref, "replacement after Stop", { captureOutput: true })
  await replacing.promise
  assert.notEqual(nativeStopToken(ref.path), oldToken)
  abortNative(ref.path, oldToken)
  replacement.resolve()
  await replacementStart
  const replacementOutput = await waitForNativeRun(ref.path)
  assert.equal(replacementOutput.state.status, "done", "a stale Stop cannot cancel the next preparation")
  assert.equal(claims, 2)
  assert.equal(releases, 2)
  prepareGate = Promise.resolve()
  prepareStarted = () => {}

  const other = randomUUID()
  memory.hold(provider, ref.nativeId, other)
  await assert.rejects(resumeNative(ref, "competing hold"), /already open|held|fixture/i)
  assert.equal(claims, 2, "a racing claim cannot spawn another writer")
  memory.release(provider, ref.nativeId, other)
  assert.equal(nativeLifecycleWork().length, 0)
  pipeDescendant = true
  await resumeNative(ref, "retain until descendant drains", { captureOutput: true })
  const descendantResult = waitForNativeRun(ref.path)
  let settled = false
  void descendantResult.then(() => { settled = true })
  const deadline = Date.now() + 5_000
  let leaderExited = false
  while (!leaderExited && Date.now() < deadline) {
    try {
      const pid = Number(await readFile(join(root, "leader-pid"), "utf8"))
      try { process.kill(pid, 0) } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") leaderExited = true
        else throw error
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
    if (!leaderExited) await delay(10)
  }
  assert.equal(leaderExited, true, "the independently spawned leader actually exited")
  assert.equal(settled, false, "leader exit cannot settle while its descendant holds output")
  assert.equal(releases, 2, "the claim remains held after leader exit")
  await assert.rejects(resumeNative(ref, "must not race descendant"), /active writer/)
  await writeFile(join(root, "release-pipes"), "release")
  const drained = await descendantResult
  assert.equal(drained.text, "leader\ndescendant:" + "🦉".repeat(16_384))
  assert.equal(releases, 3, "closed pipes release the claim exactly once")
  assert.equal(nativeLifecycleWork().length, 0)
  console.log("Native admission: refusal, concurrent preparation, exact claims, leader exit with inherited pipes and lossless descendant output verified")
} finally {
  await writeFile(join(root, "release-pipes"), "release").catch(() => {})
  bindDrivers(() => {})
  unregister()
  memory.close()
  await rm(root, { recursive: true, force: true })
}
