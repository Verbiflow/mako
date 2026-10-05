import assert from "node:assert/strict"
import { createProviderHost } from "../electron/providers/host.ts"
import { providerHost } from "../electron/providers/index.ts"
import { validateLiveDriver, type ProviderLiveDriver, type ProviderStartOptions } from "../electron/providers/live-driver.ts"
import type { LiveSessionState } from "../electron/shared.ts"

const prototype = providerHost.liveDrivers.list()[0]!
for (const driver of providerHost.liveDrivers.list()) {
  validateLiveDriver(driver)
  assert.equal(driver.nativeExclusion.kind, "unavailable", `${driver.provider}: observations do not claim native atomic exclusion`)
}
assert.throws(() => validateLiveDriver({ ...prototype, nativeExclusion: { kind: "atomic", via: "declaration alone" } }), /exclusive start implementation/)

// An injected authority proves the shared lease lifecycle, not native CLI
// cooperation. Installed acceptance must supply a real native lease adapter.
let externalOwner: string | undefined
let cleanupFailure = false
let leaseLost = false
let closes = 0
let releases = 0
let dispatched = 0
let releaseAssertion: (() => Promise<void>) | undefined
let releaseAcquisition: (() => Promise<void>) | undefined
const session = (id: string): LiveSessionState => ({ id, harness: "future-native", nativeId: "native-one", cwd: "/fixture", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] })
const driver: ProviderLiveDriver = {
  ...prototype,
  provider: "future-native",
  nativeExclusion: { kind: "atomic", via: "injected native authority" },
  start: async () => { throw new Error("Ordinary start must never bypass native acquisition") },
  startExclusive: async (_cwd, options) => {
    if (externalOwner) throw new Error("Native session held by external executor")
    externalOwner = options.conversationId
    await releaseAcquisition?.()
    return {
      session: session(options.conversationId),
      lease: {
        assertHeld: async () => {
          await releaseAssertion?.()
          if (leaseLost || externalOwner !== options.conversationId) throw new Error("Native lease lost")
        },
        release: async () => { releases++; if (externalOwner === options.conversationId) externalOwner = undefined },
      },
    }
  },
  prompt: async () => { dispatched++ },
  permission: async () => { dispatched++ },
  setMode: async () => { dispatched++ },
  cancel: async () => { dispatched++ },
  close: async () => { closes++; if (cleanupFailure) throw new Error("Native child cleanup failed") },
}
assert.throws(() => validateLiveDriver({ ...driver, nativeExclusion: { kind: "unavailable", reason: "not built" } }), /declared together/)
const host = createProviderHost()
const unregister = host.liveDrivers.register(driver)
const guarded = host.liveDrivers.get(driver.provider)!
const options: ProviderStartOptions = { conversationId: "owner-a" }
externalOwner = "external-cli"
await assert.rejects(guarded.start("/fixture", options), /held by external/)
assert.equal(closes, 0, "failed acquisition cannot close an external executor")
await guarded.close("owner-a")
assert.equal(closes, 0, "cleanup after refused startup cannot close an external executor")
externalOwner = undefined
await guarded.start("/fixture", options)
await assert.rejects(guarded.start("/fixture", options), /already has an execution owner/)
leaseLost = true
await assert.rejects(guarded.setMode("owner-a", "fixture"), /lease lost/)
await assert.rejects(guarded.cancel("owner-a"), /lease lost/, "an expired executor cannot cancel replacement native work")
assert.equal(dispatched, 0)
leaseLost = false
await guarded.setMode("owner-a", "fixture")
assert.equal(dispatched, 1)
cleanupFailure = true
await assert.rejects(async () => guarded.close("owner-a"), /cleanup failed/)
assert.equal(releases, 0, "uncertain cleanup must retain the native exclusion lease")
await assert.rejects(guarded.start("/fixture", options), /execution owner/)
cleanupFailure = false
await Promise.all([guarded.close("owner-a"), guarded.close("owner-a")])
assert.equal(releases, 1, "concurrent close shares one cleanup and release")

const acquiring = Promise.withResolvers<void>()
const acquisitionStarted = Promise.withResolvers<void>()
releaseAcquisition = () => { acquisitionStarted.resolve(); return acquiring.promise }
const starting = guarded.start("/fixture", options)
const startRejected = assert.rejects(starting, /closing|changed/)
await acquisitionStarted.promise
const closing = guarded.close("owner-a")
acquiring.resolve()
await Promise.all([startRejected, closing])
assert.equal(releases, 2, "close during acquisition cannot leak or publish its session")
releaseAcquisition = undefined
await guarded.start("/fixture", options)
const asserting = Promise.withResolvers<void>()
releaseAssertion = () => asserting.promise
const mutation = guarded.setMode("owner-a", "fixture")
const mutationRejected = assert.rejects(mutation, /changed|lease lost/)
await guarded.close("owner-a")
asserting.resolve()
await mutationRejected
assert.equal(dispatched, 1, "close while checking ownership cannot admit late input")
releaseAssertion = undefined
assert.equal(externalOwner, undefined)
await guarded.start("/fixture", options)
externalOwner = "replacement-cli"
await assert.rejects(guarded.setMode("owner-a", "fixture"), /lease lost/)
await guarded.close("owner-a")
assert.equal(externalOwner, "replacement-cli", "retiring an expired grant cannot release a replacement executor")
externalOwner = undefined
const started = performance.now()
const cpu = process.cpuUsage()
for (let cycle = 0; cycle < 500; cycle++) {
  await guarded.start("/fixture", options)
  await guarded.close("owner-a")
}
assert.equal(releases, 504, "repeated acquisition and cleanup release each exact lease")
const used = process.cpuUsage(cpu)
console.log(JSON.stringify({ source: "injected native authority, not a native/browser resource benchmark", cycles: 500, elapsedMs: Math.round((performance.now() - started) * 100) / 100, cpuMs: Math.round((used.user + used.system) / 10) / 100 }))
unregister()
assert.equal(host.liveDrivers.get(driver.provider), undefined)
console.log("Native exclusion: registry enforcement, external refusal, lost lease, cleanup retention, concurrent close, acquisition/close and mutation/close races verified with an injected authority")
