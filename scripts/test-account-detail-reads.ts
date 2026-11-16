import assert from "node:assert/strict"
import { mock } from "node:test"
import type { CloudAccount, CloudBrowserSession, CloudDevice } from "@mako/host/contracts/cloud-account"
import type { CloudSignInsState } from "@mako/host/contracts/cloud-sign-ins"
import type { MakoBridge } from "@mako/host/contracts/renderer-bridge"

/** Actual state readers and shared scheduler, with a controlled bridge and clock; no real account or network. */
const document = Object.assign(new EventTarget(), {
  visibilityState: "visible", head: { appendChild() {} },
  createElement: () => ({ setAttribute() {}, appendChild() {} }), createTextNode: () => ({}),
})
const page = new EventTarget()
Object.defineProperty(globalThis, "window", { configurable: true, value: page })
Object.defineProperty(globalThis, "document", { configurable: true, value: document })
mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 100_000 })
mock.method(performance, "now", () => Date.now())

const device: CloudDevice = { id: "00000000-0000-4000-8000-000000000001", kind: "desktop", name: "Fixture", platform: "test", appVersion: "0.0.0", enrolledBy: "browser", createdAt: "2026-11-01T00:00:00Z", lastSeenAt: "2026-11-01T00:00:00Z" }
const account = (id: string): CloudAccount => ({ cloud: "https://fixture.invalid", state: { status: "signed-in", account: { id, name: "Fixture", email: "person@example.com", image: null, entitlements: ["cloud"] }, device, connection: "connected", kept: "fixture" } })
const browser: CloudBrowserSession = { id: "browser", method: "local", browser: "Fixture", os: "test", signedInAt: "2026-11-01T00:00:00Z", signedInFrom: null, lastSeenAt: "2026-11-01T00:00:00Z", lastSeenFrom: null, expiresAt: "2026-12-01T00:00:00Z" }
const signIns: CloudSignInsState = { sharing: true, harnesses: [] }
const calls = { devices: 0, browsers: 0, signIns: 0, share: 0 }
let deviceReply: Promise<{ devices: CloudDevice[]; current: string }> | undefined
let browserFault: Error | false | undefined
const bridge = {
  cloudDevices: async () => { calls.devices++; return deviceReply ?? { devices: [device], current: device.id } },
  cloudBrowserSessions: async () => { calls.browsers++; if (browserFault !== undefined) throw browserFault; return [browser] },
  cloudSignIns: async () => { calls.signIns++; return signIns },
  cloudSignInsShare: async (sharing: boolean) => { calls.share++; return { ...signIns, sharing } },
} satisfies Pick<MakoBridge, "cloudDevices" | "cloudBrowserSessions" | "cloudSignIns" | "cloudSignInsShare">
Object.assign(page, { mako: bridge })
const { cloudAccount, cloudAccountStore, heardAccountEvent, watchAccountDetail } = await import("../src/state/cloud-account")
const { pageRefetch } = await import("../src/state/view-refetch")
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
const tick = async (ms: number) => { mock.timers.tick(ms); await flush(); mock.timers.tick(0); await flush() }
const visible = (shown: boolean) => { document.visibilityState = shown ? "visible" : "hidden"; document.dispatchEvent(new Event("visibilitychange")) }
const total = () => calls.devices + calls.browsers + calls.signIns
const join = { type: "device-joined" as const, device: { id: device.id, name: device.name, kind: device.kind, platform: device.platform, enrolledBy: "device-code" as const, from: null } }
const releases: (() => void)[] = []

try {
  cloudAccountStore.set({ account: account("a") })
  visible(false)
  releases.push(watchAccountDetail("devices", "a"), watchAccountDetail("browsers", "a"), watchAccountDetail("sign-ins", "a"))
  await tick(300_000)
  assert.equal(total(), 0, "mounting Settings in a hidden page starts no reads")
  visible(true); page.dispatchEvent(new Event("focus")); page.dispatchEvent(new Event("pageshow"))
  await tick(0)
  assert.deepEqual(calls, { devices: 1, browsers: 1, signIns: 1, share: 0 })
  releases.push(watchAccountDetail("devices", "a"))
  await flush()
  assert.equal(calls.devices, 1, "two consumers share the same complete account/query key")
  for (let i = 0; i < 2; i++) await tick(60_000)
  assert.equal(total(), 9, "visible readers keep the existing one-minute reconcile")

  visible(false)
  const hiddenAt = total()
  cloudAccount.addingMachine(true)
  for (let i = 0; i < 5; i++) {
    heardAccountEvent({ event: join, mine: false })
    await tick(60_000)
  }
  assert.equal(cloudAccountStore.get().joined?.id, device.id, "the device join is admitted while hidden")
  assert.equal(total(), hiddenAt, "neither periodic nor device-event detail reads run hidden")
  await cloudAccount.shareSignIns(false)
  assert.equal(calls.share, 1, "an explicit action remains immediate while hidden")
  assert.equal(cloudAccountStore.get().signIns?.sharing, false)
  visible(true); page.dispatchEvent(new Event("focus")); page.dispatchEvent(new Event("pageshow")); page.dispatchEvent(new Event("focus"))
  await tick(0)
  assert.equal(total(), hiddenAt + 3, "one return catch-up per active key, not per signal or duplicate consumer")

  await tick(2_000)
  const beforeBurst = calls.devices
  for (let i = 0; i < 20; i++) heardAccountEvent({ event: join, mine: true })
  await tick(0)
  assert.equal(calls.devices, beforeBurst + 1, "device events batch through the same detail reader")
  for (const release of releases) release()
  releases.length = 0
  const afterRelease = total()
  heardAccountEvent({ event: join, mine: true })
  await tick(120_000)
  assert.equal(total(), afterRelease, "a previously cached device list does not keep reading after Settings closes")

  // An old account's read must not land after the account changes, even before React releases the old effect.
  let reply: (value: { devices: CloudDevice[]; current: string }) => void = () => {}
  deviceReply = new Promise((resolve) => { reply = resolve })
  const old = watchAccountDetail("devices", "a")
  await flush()
  cloudAccountStore.set({ account: account("b") })
  old(); deviceReply = undefined
  const fresh = watchAccountDetail("devices", "b")
  await flush()
  reply({ devices: [{ ...device, name: "Old account" }], current: "old" })
  await flush()
  assert.equal(cloudAccountStore.get().devices?.current, device.id)
  fresh()

  browserFault = false
  cloudAccountStore.set({ browsers: undefined, failure: undefined })
  await cloudAccount.loadBrowsers()
  assert.equal(cloudAccountStore.get().failure?.message, "false", "falsey read failures keep their original reason")
  browserFault = undefined

  // Paired five-minute hidden schedule: old component intervals/focus with actual loaders vs the new owner.
  const sample = async (gated: boolean) => {
    const start = total()
    let stop: () => void
    if (gated) {
      const owned = [watchAccountDetail("devices", "b"), watchAccountDetail("browsers", "b"), watchAccountDetail("sign-ins", "b")]
      stop = () => owned.forEach((release) => release())
    } else {
      const read = () => { void cloudAccount.loadDevices(); void cloudAccount.loadBrowsers(); void cloudAccount.loadSignIns() }
      read(); const timer = setInterval(read, 60_000); page.addEventListener("focus", read)
      stop = () => { clearInterval(timer); page.removeEventListener("focus", read) }
    }
    await flush()
    visible(false); const before = total()
    for (let i = 0; i < 5; i++) await tick(60_000)
    const hidden = total() - before
    visible(true); page.dispatchEvent(new Event("focus")); page.dispatchEvent(new Event("pageshow"))
    await tick(0)
    stop(); await flush()
    return { total: total() - start, hidden }
  }
  const baseline = await sample(false), candidate = await sample(true)
  assert.deepEqual(baseline, { total: 21, hidden: 15 })
  assert.deepEqual(candidate, { total: 6, hidden: 0 })
  assert.equal(pageRefetch().readings().pending, 0)
  assert.equal(pageRefetch().readings().activeKeys, 0)
  console.log(JSON.stringify({ baseline, candidate, proof: "controlled five-minute hidden schedule across three actual account detail loaders, not measured host CPU/latency or simultaneous Settings tabs" }))
  console.log("account detail reads: shared keys, hidden timers/events, return, explicit action, account change and teardown pass")
} finally {
  for (const release of releases) release()
  pageRefetch().dispose()
  mock.timers.reset(); mock.restoreAll()
}
