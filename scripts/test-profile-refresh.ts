import assert from "node:assert/strict"
import type { HarnessProfile } from "../electron/shared.ts"
const requests: {
  provider: string
  cwd?: string
  resolve(value: HarnessProfile): void
  reject(error: Error): void
}[] = []
Object.assign(globalThis, {
  window: {
    mako: {
      harnessTuning: (provider: string, cwd?: string) =>
        new Promise<HarnessProfile>((resolve, reject) =>
          requests.push({ provider, cwd, resolve, reject })
        ),
    },
  },
})
const { admitProfile, discoveryRetry, providers, providerStore, providerProfileKey } =
  await import("../src/state/providers.ts")
discoveryRetry.firstMs = 20
discoveryRetry.maxMs = 40
const waitFor = async (count: number, budgetMs: number) => {
  const until = Date.now() + budgetMs
  while (requests.length < count && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(requests.length, count)
}
const profile: HarnessProfile = {
  id: "test",
  label: "Test",
  models: [],
  available: true,
  transport: "acp",
  capabilities: [],
  settings: { model: "old-account" },
}
const old = providers.load("test", false, "/work")
assert.equal(requests.length, 1)
const refresh = providers.refreshAccount("test")
assert.equal(requests.length, 2)
requests[1]!.resolve({ ...profile, settings: { model: "new-account" } })
await refresh
requests[0]!.resolve(profile)
await old
assert.equal(
  providerStore.get().contexts[providerProfileKey("test", "/work")]?.settings
    ?.model,
  "new-account"
)
await providers.load("test", false, "/work")
assert.equal(requests.length, 2, "fresh scoped config should be reused")
const another = providers.load("test", false, "/other")
assert.equal(requests.length, 3)
requests[2]!.resolve({ ...profile, settings: { model: "other-workspace" } })
await another
assert.equal(
  providerStore.get().contexts[providerProfileKey("test", "/work")]?.settings
    ?.model,
  "new-account"
)
console.log(
  "Profile refresh: account changes invalidate pending discovery; workspace settings remain isolated"
)

const failed = providers.load("test", true, "/work")
requests[3]!.reject(new Error("Provider discovery failed"))
await assert.rejects(failed, /Provider discovery failed/)
assert.equal(
  providerStore.get().contextErrors[providerProfileKey("test", "/work")],
  "Provider discovery failed"
)
const retry = providers.load("test", true, "/work")
requests[4]!.resolve(profile)
await retry
assert.equal(
  providerStore.get().contextErrors[providerProfileKey("test", "/work")],
  undefined
)

const unavailable = providers.load("test", true, "/work")
requests[5]!.resolve({
  ...profile,
  available: false,
  models: [],
  settings: undefined,
  error: "Timed out",
})
await unavailable
const retained =
  providerStore.get().contexts[providerProfileKey("test", "/work")]
assert.equal(retained?.settings?.model, profile.settings?.model)
assert.match(retained?.configurationError ?? "", /last reported/)
// The failed refresh asks again on its own; a good answer ends that.
await waitFor(7, 500)
requests[6]!.resolve(profile)
await new Promise((resolve) => setTimeout(resolve, 0))

// A new workspace answers with the account's catalog marked pending; the
// workspace's own report replaces it and a later borrowed answer never wins.
const borrowed: HarnessProfile = {
  ...profile,
  models: [{ id: "account-model", label: "Account model", options: [] }],
  settings: undefined,
  pending: true,
}
const fresh = providers.load("test", false, "/fresh")
requests[7]!.resolve(borrowed)
await fresh
const freshKey = providerProfileKey("test", "/fresh")
assert.equal(providerStore.get().contexts[freshKey]?.pending, true)
assert.equal(providerStore.get().contexts[freshKey]?.models.length, 1, "the picker has the account's models before discovery")
const again = providers.load("test", false, "/fresh")
assert.equal(requests.length, 9, "a borrowed answer does not arm the reuse window")
const landed = { ...borrowed, pending: undefined, settings: { model: "workspace-default" } }
admitProfile(landed, "/fresh")
requests[8]!.resolve(borrowed)
await again
assert.equal(providerStore.get().contexts[freshKey]?.settings?.model, "workspace-default", "a late borrowed answer never replaces the workspace's own report")
console.log("Profile refresh: a borrowed catalog is provisional and yields to the workspace's report")

// A failed discovery asks again on its own, backing off, and stops once the
// provider answers; the composer never waits for a window focus to recover.
const timedOut = providers.load("test", true, "/retry")
requests[9]!.resolve({
  ...profile,
  available: false,
  models: [],
  settings: undefined,
  error: "cursor-agent discovery timed out",
})
await timedOut
const retryKey = providerProfileKey("test", "/retry")
assert.equal(providerStore.get().contexts[retryKey]?.available, false)
await waitFor(11, 500)
assert.equal(requests[10]!.cwd, "/retry", "the retry asks for the failed workspace")
requests[10]!.resolve({ ...profile, available: false, models: [], settings: undefined, error: "still down" })
await waitFor(12, 500)
requests[11]!.resolve({ ...profile, settings: { model: "recovered" } })
await new Promise((resolve) => setTimeout(resolve, 120))
assert.equal(requests.length, 12, "a successful answer ends the retries")
assert.equal(providerStore.get().contexts[retryKey]?.settings?.model, "recovered")
console.log("Profile refresh: a failed discovery retries with backoff until it answers")
