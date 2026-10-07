import assert from "node:assert/strict"
import { mock } from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { providerHost } from "../electron/providers/index.ts"
import { providerProfileCache } from "../electron/provider-profile-cache.ts"
import { harnessProfile, harnessProfileForSend, onHarnessProfile, refreshHarnessProfiles, stopHarnessProfiles } from "../electron/harnesses.ts"
import type { HarnessProfile } from "../electron/shared.ts"

const root = await mkdtemp(join(tmpdir(), "mako-profile-shutdown-"))
const persist = mock.method(providerProfileCache, "put", async () => {})
const recall = mock.method(providerProfileCache, "get", async () => null)
const nearest = mock.method(providerProfileCache, "nearest", async () => null)
const unregister: (() => void)[] = []
const gates: (() => void)[] = []
const rejected: Promise<void>[] = []
const signals: AbortSignal[] = []
let entered = 0
let completed = 0
let published = 0
const unlisten = onHarnessProfile(() => { published++ })
async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "Profile owner did not reach its expected boundary")
    await delay(5)
  }
}
try {
  const families = [...providerHost.liveDrivers.list().map(driver => driver.provider), "future-harness"]
  for (const family of families) {
    const provider = `profile-shutdown-${family}`
    const profile: HarnessProfile = { id: provider, label: family, available: true, transport: "sdk", models: [] }
    const load = async (_env: NodeJS.ProcessEnv, _cwd?: string, context?: { signal: AbortSignal }) => {
      assert.ok(context)
      signals.push(context.signal)
      entered++
      const cleanup = Promise.withResolvers<void>()
      gates.push(() => cleanup.resolve())
      // Native query cleanup may lag cancellation. Return success anyway to
      // prove the host fence rejects even an adapter's late successful result.
      await cleanup.promise
      completed++
      return profile
    }
    unregister.push(providerHost.profiles.register({ provider, label: family, transport: "sdk", defaults: { work: [] }, cacheKey: () => "fixture", load, loadForSend: load }))
    rejected.push(assert.rejects(harnessProfile(provider, true, root), /superseded|shutting down/))
    await until(() => entered === signals.length && signals.length === families.indexOf(family) * 3 + 1)
    // Supersession removes the old public loading entry. Its native owner
    // must still be joined by shutdown alongside the replacement.
    const refresh = refreshHarnessProfiles(provider)
    await until(() => entered === families.indexOf(family) * 3 + 2)
    assert.equal(signals.at(-2)!.aborted, true)
    rejected.push(refresh)
    rejected.push(assert.rejects(harnessProfileForSend(provider, root), /shutting down/))
    await until(() => entered === families.indexOf(family) * 3 + 3)
  }
  const drain = stopHarnessProfiles(50)
  const failedDrain = assert.rejects(drain, /ownership was retained/)
  assert.equal(stopHarnessProfiles(50), drain, "Shutdown callers share the exact query drain")
  assert.ok(signals.every(signal => signal.aborted), "All display, send and superseded query owners are cancelled")
  await assert.rejects(harnessProfile("profile-shutdown-future-harness", true, root), /shutting down/)
  await assert.rejects(refreshHarnessProfiles("profile-shutdown-future-harness"), /shutting down/)
  await failedDrain
  assert.equal(completed, 0, "Timeout cannot pretend native cleanup has completed")
  assert.equal(persist.mock.callCount(), 0)
  const retry = stopHarnessProfiles()
  let settled = false
  void retry.then(() => { settled = true })
  // Leave one superseded owner behind while all public-map owners complete.
  for (const release of gates.slice(1)) release()
  await until(() => completed === gates.length - 1)
  await delay(5)
  assert.equal(settled, false, "Removed superseded owner remains part of the drain")
  gates[0]!()
  await Promise.all(rejected)
  await retry
  assert.equal(completed, families.length * 3)
  assert.equal(published, 0, "No late profile may publish after shutdown")
  assert.equal(persist.mock.callCount(), 0, "No late successful query may persist after shutdown")
  await stopHarnessProfiles()
  console.log(`Profile shutdown: ${families.length} shared families; display/send/superseded owners, awaited cleanup, timeout retry and late publication fences verified`)
} finally {
  for (const release of gates) release()
  await Promise.allSettled(rejected)
  await stopHarnessProfiles().catch(() => {})
  for (const remove of unregister) remove()
  unlisten()
  persist.mock.restore()
  recall.mock.restore()
  nearest.mock.restore()
  await rm(root, { recursive: true, force: true })
}
