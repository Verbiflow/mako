import assert from "node:assert/strict"
import { mock } from "node:test"
import { takeUpdates } from "../src/web-client/update"
import { pageRefetch } from "../src/state/view-refetch"

for (const name of ["HTMLElement", "HTMLInputElement", "HTMLTextAreaElement"]) Object.defineProperty(globalThis, name, { configurable: true, value: class {} })
const page = new EventTarget()
const document = Object.assign(new EventTarget(), { visibilityState: "visible", querySelector: () => null, activeElement: null })
let reloads = 0
const storage = new Map<string, string>()
Object.defineProperty(globalThis, "window", { configurable: true, value: page })
Object.defineProperty(globalThis, "document", { configurable: true, value: document })
Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://fixture.invalid", pathname: "/", search: "", reload: () => { reloads++ } } })
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { setItem: (key: string, value: string) => { storage.set(key, value) } } })
let calls = 0
let served = "a"
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { calls++; return Response.json({ build: served }) }
mock.method(performance, "now", () => Date.now())
mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 100_000 })
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
const tick = async (ms: number) => { mock.timers.tick(ms); await flush(); mock.timers.tick(0); await flush() }
const visible = (shown: boolean) => {
  document.visibilityState = shown ? "visible" : "hidden"
  document.dispatchEvent(new Event("visibilitychange"))
}
try {
  const looked = { apps: 0, sync: 0, output: 0, preview: 0, devices: 0 }
  const leases = (["apps", "sync", "output", "preview", "devices"] as const).map((domain) => pageRefetch().watch(`fixture:${domain}`, {
    scope: domain, domain, fields: ["all"], every: () => undefined,
    read: async () => { looked[domain]++ },
  }))
  const counts = (expected: number) => {
    for (const [domain, count] of Object.entries(looked)) assert.equal(count, expected, `${domain} catches up once`)
  }
  const stop = takeUpdates("a", "/")
  await flush()
  assert.equal(calls, 1)
  counts(1)
  page.dispatchEvent(new Event("focus"))
  await tick(0)
  assert.equal(calls, 2, "a focus-only return refreshes a visible page")
  counts(2)
  visible(false)
  page.dispatchEvent(new Event("focus"))
  await tick(15 * 60_000)
  assert.equal(calls, 2, "hidden pages ignore both focus and five-minute build polling")
  counts(2)
  served = "b"
  visible(true)
  page.dispatchEvent(new Event("pageshow"))
  await tick(0)
  await tick(5)
  page.dispatchEvent(new Event("focus"))
  await tick(0)
  assert.equal(calls, 3, "return catches up once across visibility, pageshow and later focus")
  counts(3)
  visible(false)
  await tick(20_000)
  assert.equal(reloads, 0, "a queued update cannot reload a hidden page")
  visible(true)
  await tick(1_000)
  assert.equal(reloads, 1, "a queued update survives hiding and takes the next visible quiet moment")
  stop()
  for (const lease of leases) lease.release()
  const end = calls
  await tick(30 * 60_000)
  assert.equal(calls, end, "a stopped update reader owns no poll")
} finally {
  pageRefetch().dispose()
  mock.timers.reset()
  mock.restoreAll()
  globalThis.fetch = originalFetch
}
console.log("web updates: hidden polling and reloads stop, one return catch-up, queued update and teardown pass")
