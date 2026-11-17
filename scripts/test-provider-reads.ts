import assert from "node:assert/strict"
import { mock } from "node:test"
import type { HarnessProfile } from "@mako/host/contracts/providers-acp"
import type { MakoBridge } from "@mako/host/contracts/renderer-bridge"

/** Actual provider/cache/retry owner and page scheduler; controlled bridge and clock, no provider or network. */
const document = Object.assign(new EventTarget(), { visibilityState: "visible" })
const page = new EventTarget()
Object.assign(globalThis, { window: page, document })
mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 100_000 })
mock.method(performance, "now", () => Date.now())
const profile = (id: string, model = "current"): HarnessProfile => ({ id, label: id, available: true, transport: "acp", models: [], settings: { model } })
const calls: { provider: string; cwd: string; force?: boolean }[] = []
let failed = false
let reply: Promise<HarnessProfile> | undefined
const bridge = {
  harnessTuning: async (provider: string, cwd?: string, force?: boolean) => {
    calls.push({ provider, cwd: cwd ?? "", force })
    return reply ?? (failed ? { ...profile(provider), available: false, error: "offline" } : profile(provider))
  },
} satisfies Pick<MakoBridge, "harnessTuning">
Object.assign(page, { mako: bridge })
const { admitProfile, providers, providerStore, providerProfileKey, watchProviderProfile } = await import("../src/state/providers")
const { pageRefetch } = await import("../src/state/view-refetch")
const { DESK_SCOPE } = await import("../src/state/desk-refetch")
const reads = pageRefetch()
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const tick = async (ms: number) => {
  if (!ms) { mock.timers.tick(0); await flush(); return }
  for (let i = 0; i < ms; i += 1_000) { mock.timers.tick(Math.min(1_000, ms - i)); await flush() }
}
const visible = (shown: boolean) => { document.visibilityState = shown ? "visible" : "hidden"; document.dispatchEvent(new Event("visibilitychange")) }
const focus = () => page.dispatchEvent(new Event("focus"))
const releases: (() => void)[] = []
try {
  visible(false)
  releases.push(watchProviderProfile("one", "/work"), watchProviderProfile("one", "/work"))
  await tick(600_000)
  focus(); await tick(0)
  assert.equal(calls.length, 0, "hidden mounts and focus start no passive discovery")
  visible(true); focus(); page.dispatchEvent(new Event("pageshow")); focus()
  await tick(0)
  assert.equal(calls.length, 1, "duplicate consumers and return signals share a single request")
  releases.push(watchProviderProfile("one", "/other"), watchProviderProfile("two", "/work"))
  await flush()
  assert.equal(calls.length, 3, "provider and cwd both partition the request")
  await tick(300_000)
  assert.equal(calls.length, 6, "visible profiles retain their five-minute reconcile")
  for (const release of releases) release()
  releases.length = 0
  const released = calls.length
  await tick(300_000); focus(); await tick(0)
  assert.equal(calls.length, released, "last release ends passive periodic and focus reads")

  // Matched schedule to baseline.mts on pinned main: 60 s shown, 600 s hidden, 300 s shown.
  const start = calls.length
  const healthyWatch = watchProviderProfile("healthy", "/healthy")
  await flush(); await tick(60_000)
  visible(false); const hiddenStart = calls.length
  await tick(600_000)
  const hidden = calls.length - hiddenStart
  visible(true); focus(); await tick(0); await tick(300_000)
  const healthy = { calls: calls.length - start, hidden }
  assert.deepEqual(healthy, { calls: 3, hidden: 0 })
  healthyWatch()

  failed = true
  const beforeFailure = calls.length
  const failedWatch = watchProviderProfile("failed", "/failed")
  await flush(); visible(false)
  const beforeHiddenFailure = calls.length
  await tick(600_000)
  const failure = { calls: calls.length - beforeFailure, hidden: calls.length - beforeHiddenFailure }
  assert.deepEqual(failure, { calls: 1, hidden: 0 })
  visible(true); focus(); await tick(0)
  assert.equal(calls.length, beforeHiddenFailure + 1, "one overdue retry catches up on return")
  assert.equal(calls.at(-1)?.force, true)
  for (let i = 0; i < 3; i++) { await tick(3_000); focus(); await tick(0) }
  assert.equal(calls.length, beforeHiddenFailure + 1, "focus cannot bypass a failed discovery's doubled backoff")
  await tick(11_000)
  assert.equal(calls.length, beforeHiddenFailure + 2, "failure still retries at the existing 20 s backoff")
  admitProfile(profile("failed"), "/failed")
  failedWatch(); failed = false
  const recovered = calls.length
  await tick(120_000)
  assert.equal(calls.length, recovered, "the host's successful profile ends retry ownership")

  // Retries created by an explicit caller without a mounted composer also park while hidden or disconnected.
  visible(false); failed = true
  await providers.load("action", true, "/action")
  const actionAt = calls.length
  assert.equal(calls.at(-1)?.provider, "action", "explicit refresh stays immediate while hidden")
  await tick(120_000)
  assert.equal(calls.length, actionAt)
  reads.setConnected(DESK_SCOPE, false); visible(true); await tick(120_000)
  assert.equal(calls.length, actionAt, "disconnected pages do not retry")
  failed = false
  reads.setConnected(DESK_SCOPE, true); await tick(0)
  assert.equal(calls.length, actionAt + 1)
  await tick(120_000)
  assert.equal(calls.length, actionAt + 1, "a successful retry stops the timer")

  // Neither a hide nor a new account lets an old account's reply overwrite the new one.
  const old = Promise.withResolvers<HarnessProfile>()
  reply = old.promise
  const pending = providers.load("switch", true, "/account")
  visible(false)
  reply = undefined
  await providers.refreshAccount("switch")
  old.resolve(profile("switch", "old-account")); await pending
  assert.equal(providerStore.get().contexts[providerProfileKey("switch", "/account")]?.settings?.model, "current")
  assert.equal(reads.readings().activeKeys, 0)
  assert.equal(reads.readings().pending, 0)
  console.log(JSON.stringify({ healthy, failed: failure, proof: "matched controlled cadence with actual provider/cache/retry owner, not host CPU or UI latency" }))
  console.log("provider readers: shared interests, hidden/focus/return, retry backoff, explicit calls, reconnect, account fence and teardown pass")
} finally {
  for (const release of releases) release()
  reads.dispose(); mock.timers.reset(); mock.restoreAll()
}
