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
const profile = (id: string, model = "current"): HarnessProfile => ({ id, label: id, available: true, transport: "acp", models: [{ id: model, label: model, options: [] }], settings: { model } })
/** Each read of one harness: `force` is an ask of the harness itself, which is what a discovery costs. */
const calls: { provider: string; cwd: string; force?: boolean }[] = []
const asks = () => calls.filter((call) => call.force === true)
let boots = 0
let failed = false
let reply: Promise<HarnessProfile> | undefined
/** What the host holds at a window's start: two snapshots, one of them past its freshness, and a harness never read. */
const held: HarnessProfile[] = [profile("one"), { ...profile("two"), stale: true }, { id: "three", label: "three", available: false, pending: true, transport: "acp", models: [] }]
const bridge = {
  harnessProfiles: async () => { boots++; return held },
  harnessTuning: async (provider: string, cwd?: string, force?: boolean) => {
    calls.push({ provider, cwd: cwd ?? "", force })
    return reply ?? (failed ? { ...profile(provider), available: false, models: [], error: "offline" } : profile(provider))
  },
} satisfies Pick<MakoBridge, "harnessTuning" | "harnessProfiles">
Object.assign(page, { mako: bridge })
const { admitProfile, discoveryRetry, profileUnread, providers, providerStore, providerProfileKey } = await import("../src/state/providers")
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
try {
  // A window's start paints what the host holds and reads no harness.
  await providers.loadAll()
  assert.equal(boots, 1)
  assert.equal(calls.length, 0, "a window's start asks no harness")
  const shown = providerStore.get().profiles
  assert.deepEqual(Object.keys(shown), ["one", "two", "three"])
  assert.equal(profileUnread(shown.one), false, "a held list is shown")
  assert.equal(profileUnread(shown.two), false, "and one past its freshness, while it is refreshed")
  assert.equal(profileUnread(shown.three), true, "only a harness with nothing held reads as checking")
  assert.equal(profileUnread(undefined), true)
  assert.equal(profileUnread({ ...profile("one"), pending: true }), false, "models are shown whenever there are any")

  // A composer reads its harness once as it mounts, and nothing reads it again on a clock or a focus.
  await providers.load("one", false, "/work")
  await providers.load("one", false, "/work")
  assert.deepEqual(calls, [{ provider: "one", cwd: "/work", force: false }], "consumers of one profile share one read")
  await tick(900_000)
  visible(false); visible(true); focus(); page.dispatchEvent(new Event("pageshow")); focus()
  await tick(0)
  await tick(900_000)
  assert.equal(calls.length, 1, "neither a clock nor a focus reads a profile again")
  assert.equal(asks().length, 0)

  // A page that lists every harness's models reads the ones nothing is held for, and only those.
  const before = calls.length
  await providers.loadListed()
  assert.deepEqual(calls.slice(before), [{ provider: "three", cwd: "", force: false }])

  // Opening the picker asks each harness it lists, once.
  await Promise.all([providers.askShown("/work"), providers.askShown("/work"), providers.load("one", true, "/work")])
  assert.deepEqual(asks().map((call) => [call.provider, call.cwd]), [["one", "/work"], ["two", "/work"], ["three", "/work"]], "opening the picker asks exactly once per harness shown")
  assert.equal(boots, 1)
  assert.equal(providerStore.get().contexts[providerProfileKey("two", "/work")]?.stale, undefined, "what the harness answered replaces the stale snapshot")

  // The picker's rows read as they mount; the ask made by opening it is not answered by one of those reads.
  const mounting = Promise.withResolvers<HarnessProfile>()
  reply = mounting.promise
  const mounted = providers.load("one", false, "/rows")
  reply = undefined
  const opened = providers.load("one", true, "/rows")
  assert.deepEqual(calls.slice(-2).map((call) => call.force), [false, true], "a read in flight does not swallow an ask")
  await opened
  mounting.resolve(profile("one", "held-before-the-ask")); await mounted
  assert.equal(providerStore.get().contexts[providerProfileKey("one", "/rows")]?.settings?.model, "current", "and its late reply never lands over what the harness answered")

  // A failed discovery is read again on a doubling clock, and each read leaves the retry itself to the host.
  failed = true
  const failedAt = calls.length
  const askedBefore = asks().length
  await providers.load("failed", false, "/failed")
  assert.equal(calls.length, failedAt + 1)
  visible(false)
  await tick(600_000)
  assert.equal(calls.length, failedAt + 1, "a hidden page retries nothing")
  visible(true); focus(); await tick(0)
  assert.equal(calls.length, failedAt + 2, "one overdue retry catches up on return")
  assert.equal(calls.at(-1)?.force, false, "a retry reads what the host holds; it never forces a discovery")
  for (let i = 0; i < 3; i++) { await tick(3_000); focus(); await tick(0) }
  assert.equal(calls.length, failedAt + 2, "focus cannot bypass a failed discovery's doubled backoff")
  await tick(11_000)
  assert.equal(calls.length, failedAt + 3, "the second retry waits 20 s")
  const backedOff = calls.length
  await tick(3_600_000)
  const hourly = calls.length - backedOff
  assert.ok(hourly >= 5 && hourly <= 10, `an hour of failure is a handful of reads at the ${discoveryRetry.maxMs / 60_000} minute cap, not one every two minutes (${hourly})`)
  assert.equal(asks().length, askedBefore, "and none of them asks the harness")
  admitProfile(profile("failed"), "/failed")
  failed = false
  const recovered = calls.length
  await tick(1_200_000)
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
  await tick(1_200_000)
  assert.equal(calls.length, actionAt + 1, "a successful retry stops the timer")

  // Neither a hide nor a new account lets an old account's reply overwrite the new one.
  const old = Promise.withResolvers<HarnessProfile>()
  reply = old.promise
  const pending = providers.load("switch", true, "/account")
  visible(false)
  reply = undefined
  const switchAt = asks().length
  await providers.refreshAccount("switch")
  assert.equal(asks().length, switchAt + 1, "an account that changed asks its harness again")
  old.resolve(profile("switch", "old-account")); await pending
  assert.equal(providerStore.get().contexts[providerProfileKey("switch", "/account")]?.settings?.model, "current")
  assert.equal(reads.readings().activeKeys, 0)
  assert.equal(reads.readings().pending, 0)
  console.log("provider readers: a window's start asks no harness, the picker asks each once, nothing reads on a clock or a focus, failed reads back off unforced, and explicit calls, reconnect and the account fence pass")
} finally {
  reads.dispose(); mock.timers.reset(); mock.restoreAll()
}
