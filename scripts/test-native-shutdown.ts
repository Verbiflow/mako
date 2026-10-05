import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { bindDrivers, resumeNative, startFresh, stopDrivers, threadRun, nativeLifecycleWork } from "../electron/drivers.ts"
import { bindLifecycleAdmission } from "../electron/application-lifecycle.ts"
import { providerHost } from "../electron/providers/index.ts"
import { SessionMemory } from "../electron/session-memory.ts"
import type { ThreadRef } from "@mako/sessions"

const root = await mkdtemp(join(tmpdir(), "mako-native-shutdown-"))
const memory = new SessionMemory(join(root, "memory.sqlite"), { pid: process.pid, startedAt: Date.now(), label: "shutdown fixture" })
const unregister: (() => void)[] = []
const releases: string[] = []
const directories: string[] = []
const pending: Promise<void>[] = []
const gates: (() => void)[] = []
const refs: ThreadRef[] = []
const assessments = new Map<string, () => Promise<void>>()
let failReleaseOnce = true
let claimed = 0
let built = 0
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 5_000
  while (!await predicate()) {
    assert.ok(performance.now() < deadline, "Owned work did not reach its expected boundary")
    await delay(5)
  }
}
bindDrivers(() => {}, {
  assessResume: async ref => {
    await assessments.get(ref.path)?.()
    return { kind: "resumable", record: "unknown" }
  },
  claimSession: ref => {
    const token = randomUUID()
    memory.hold(ref.harness, ref.nativeId, token)
    claimed++
    return () => {
      if (ref.nativeId === "release-retry" && failReleaseOnce) {
        failReleaseOnce = false
        throw new Error("Fixture ledger temporarily busy")
      }
      memory.release(ref.harness, ref.nativeId, token)
      releases.push(ref.path)
    }
  },
})
try {
  // Exercise the shared owner for every declared family and a future adapter,
  // without dispatching through any installed provider CLI.
  const families = [...providerHost.liveDrivers.list().map(driver => driver.provider), "future-harness"]
  for (const family of families) {
    const provider = `shutdown-fixture-${family}`
    const directory = join(root, family)
    await mkdir(directory)
    directories.push(directory)
    const phases = new Map<string, { entered: boolean; promise: Promise<void> }>()
    for (const phase of ["credential", "prepare", "build", "assessment"]) {
      const gate = Promise.withResolvers<void>()
      phases.set(phase, { entered: false, promise: gate.promise })
      gates.push(() => gate.resolve())
    }
    const block = async (phase: string) => {
      const entry = phases.get(phase)!
      entry.entered = true
      await entry.promise
    }
    // Credentials run first: use a distinct fixture runner per preparation
    // boundary so no global mutable selection can alter the admitted request.
    for (const phase of ["running", "credential", "prepare", "build", "assessment"]) {
      const id = `${provider}-${phase}`
      unregister.push(providerHost.nativeRunners.register({
        provider: id, transport: "fixture-headless", available: () => true, carries: [], fastMode: "unsupported",
        launchCredentials: { kind: "resolved", resolve: async env => {
          if (phase === "credential") await block(phase)
          return { env, credential: { kind: "unavailable", reason: "Test fixture has no native account" } }
        } },
        prepare: async options => {
          if (phase === "prepare") await block(phase)
          return { options, dropped: [] }
        },
        resume: async () => {
          if (phase === "build") await block(phase)
          built++
          return { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/native-shutdown-child.mjs", import.meta.url)), directory] }
        },
        fresh: () => { throw new Error("Shutdown must not fall back to fresh dispatch") }, describe: () => ({}),
      }))
      const ref: ThreadRef = { harness: id, nativeId: family === families[0] && phase === "running" ? "release-retry" : phase, path: join(directory, phase), cwd: root }
      if (phase === "assessment") assessments.set(ref.path, () => block(phase))
      refs.push(ref)
      if (phase === "running") {
        await resumeNative(ref, "owned fixture", { captureOutput: false })
        await until(async () => { try { return Number(await readFile(join(directory, "ready"), "utf8")) > 0 } catch { return false } })
      } else {
        const request = resumeNative(ref, "must not be dispatched")
        pending.push(assert.rejects(request, /shutting down/))
        await until(() => phases.get(phase)!.entered)
      }
    }
  }
  assert.equal(claimed, families.length)
  const drain = stopDrivers(100)
  const failedDrain = assert.rejects(drain, /ownership was retained/)
  assert.equal(stopDrivers(100), drain, "Concurrent shutdown callers join the exact drain")
  // application.dispose() resets its callback; the native owner must retain
  // its own terminal admission fence anyway.
  bindLifecycleAdmission(() => false)
  await assert.rejects(startFresh(refs[0]!.harness, root, "late fresh"), /shutting down/)
  await Promise.all(directories.map(directory => until(async () => { try { await readFile(join(directory, "stopping")); return true } catch { return false } })))
  await failedDrain
  assert.equal(releases.length, 0, "SIGTERM and drain timeout cannot release a live child claim")
  assert.equal(nativeLifecycleWork().length, families.length * 5)
  for (const release of gates) release()
  await Promise.all(pending)
  assert.equal(built, families.length * 3, "Late command construction may finish; admission still forbids its spawn")
  assert.equal(claimed, families.length, "No late preparation can claim a session after shutdown")
  await Promise.all(directories.map(directory => writeFile(join(directory, "release"), "release")))
  await until(() => refs.filter(ref => ref.nativeId === "running" || ref.nativeId === "release-retry").every(ref => threadRun(ref.path)?.status !== "running"))
  assert.equal(releases.length, families.length - 1)
  const retained = nativeLifecycleWork()
  assert.equal(retained.length, 1, "A failed ledger release remains visible and prevents host closure")
  assert.equal(retained[0]!.status, "finishing")
  assert.equal(retained[0]!.stoppable, false)
  await assert.rejects(resumeNative(refs[0]!, "cannot replace retained owner"), /retained ownership/)
  await stopDrivers()
  assert.equal(releases.length, families.length, "Retry releases only the failed exact claim")
  assert.equal(nativeLifecycleWork().length, 0)
  await stopDrivers()
  assert.equal(releases.length, families.length, "Repeated settled shutdown cannot release twice")
  console.log(`Native shutdown: ${families.length} shared families; uncaptured children, delayed close, timeout retention, late preparation fences and exact failed-release retry verified`)
} finally {
  for (const release of gates) release()
  await Promise.all(directories.map(directory => writeFile(join(directory, "release"), "release")))
  await Promise.allSettled(pending)
  await stopDrivers().catch(() => {})
  bindDrivers(() => {})
  for (const remove of unregister) remove()
  memory.close()
  await rm(root, { recursive: true, force: true })
}
