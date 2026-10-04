import assert from "node:assert/strict"
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { bindDrivers, resumeNative, waitForNativeRun, threadRun, nativeLifecycleWork } from "../electron/drivers.ts"
import { providerHost } from "../electron/providers/index.ts"
import { SessionMemory } from "../electron/session-memory.ts"
import type { ResumeVerdict } from "../electron/contracts/conversation-control.ts"
import type { ThreadRef } from "@mako/sessions"

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
const unregister = providerHost.nativeRunners.register({
  provider, available: () => true, fastMode: "unsupported", carries: [],
  prepare: async options => { preparations++; await prepareGate; return { options, dropped: [] } },
  resume: () => ({ command: process.execPath, args: pipeDescendant
    ? [fileURLToPath(new URL("./fixtures/native-pipe-child.mjs", import.meta.url)), "leader", root]
    : ["-e", "console.log('own-native-fixture'); setTimeout(() => {}, 40)"] }),
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
  gate.resolve()
  await first
  assert.equal(preparations, before + 1, "only the winning request prepares the native command")
  assert.equal(claims, 1)
  const output = await waitForNativeRun(ref.path)
  assert.equal(output.state.status, "done")
  assert.equal(output.text.trim(), "own-native-fixture")
  assert.equal(releases, 1, "settlement releases the exact cooperating-host claim once")

  const other = randomUUID()
  memory.hold(provider, ref.nativeId, other)
  await assert.rejects(resumeNative(ref, "competing hold"), /already open|held|fixture/i)
  assert.equal(claims, 1, "a racing claim cannot spawn another writer")
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
  assert.equal(releases, 1, "the claim remains held after leader exit")
  await assert.rejects(resumeNative(ref, "must not race descendant"), /active writer/)
  await writeFile(join(root, "release-pipes"), "release")
  const drained = await descendantResult
  assert.equal(drained.text, "leader\ndescendant:" + "🦉".repeat(16_384))
  assert.equal(releases, 2, "closed pipes release the claim exactly once")
  assert.equal(nativeLifecycleWork().length, 0)
  console.log("Native admission: refusal, concurrent preparation, exact claims, leader exit with inherited pipes and lossless descendant output verified")
} finally {
  await writeFile(join(root, "release-pipes"), "release").catch(() => {})
  bindDrivers(() => {})
  unregister()
  memory.close()
  await rm(root, { recursive: true, force: true })
}
