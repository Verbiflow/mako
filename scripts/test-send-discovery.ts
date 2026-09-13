import assert from "node:assert/strict"
import { mock } from "node:test"
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { providerHost } from "../electron/providers/index.js"
import { providerProfileCache } from "../electron/provider-profile-cache.js"
import {
  FAILED_DISCOVERY_TTL_MS,
  harnessProfile,
  harnessProfileForSend,
  harnessProfilesNow,
  resolveHarnessLaunch,
  onHarnessProfile,
} from "../electron/harnesses.js"
import type { HarnessProfile } from "../electron/shared.js"

let account = "one"
let loads = 0
/** Real discovery takes seconds; hold the fixture open to observe what answers meanwhile. */
let hold: Promise<void> | null = null
/** The CLI's failure of the moment: a timed-out model listing, a crash. */
let failWith: Error | null = null
const profile: HarnessProfile = {
  id: "queue-profile-test",
  label: "Test",
  available: true,
  transport: "sdk",
  models: [{ id: "account-model", label: "Account model", options: [] }],
  capabilities: [],
  settings: { model: "account-model" },
}
providerHost.profiles.register({
  provider: profile.id,
  label: "Test",
  transport: "sdk",
  capabilities: [],
  cacheKey: () => account,
  load: async () => {
    loads++
    if (hold) await hold
    if (failWith) throw failWith
    return profile
  },
})
const persist = mock.method(providerProfileCache, "put", async () => {})
const recall = mock.method(providerProfileCache, "get", async () => null)
const nearest = mock.method(providerProfileCache, "nearest", async () => null)
const originalTime = Date.now()
let now = originalTime
const clock = mock.method(Date, "now", () => now)
const reported: (string | undefined)[] = []
const stopReporting = onHarnessProfile((event) => {
  if (event.profile.id === profile.id) reported.push(event.cwd)
})
// Only the fixture provider: the installed CLIs must never run under a test.
const only = mock.method(providerHost.profiles, "list", () => [
  providerHost.profiles.get(profile.id)!,
])
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 5000
  while (!predicate()) {
    assert.ok(
      performance.now() < deadline,
      "Discovery did not reach the expected phase"
    )
    await settle()
  }
}
try {
  assert.equal(
    await resolveHarnessLaunch(profile.id, "/one", undefined),
    undefined
  )
  const nativeOptions = { options: { effort: "high" } }
  assert.equal(
    await resolveHarnessLaunch(profile.id, "/one", nativeOptions),
    nativeOptions
  )
  assert.equal(
    loads,
    0,
    "Native defaults and model-free options cannot wait for model discovery"
  )
  const cacheGate = Promise.withResolvers<null>()
  recall.mock.mockImplementationOnce(() => cacheGate.promise)
  let answered = false
  const immediate = harnessProfilesNow("/one").then((profiles) => {
    answered = true
    return profiles
  })
  await settle()
  cacheGate.resolve(null)
  assert.equal(
    answered,
    true,
    "Provider names cannot wait for cache, account, or model discovery"
  )
  const pending = await immediate
  assert.ok(
    pending.some((entry) => entry.id === profile.id && entry.pending),
    "An unknown provider answers as pending instead of blocking the list"
  )
  await until(() => reported.length >= 1)
  assert.equal(loads, 1)
  assert.deepEqual(reported, ["/one"], "Discovery reports through the event")
  const freshGate = Promise.withResolvers<void>()
  hold = freshGate.promise
  const borrowed = await harnessProfile(profile.id, false, "/fresh")
  assert.equal(
    borrowed.pending,
    true,
    "A workspace without a snapshot answers with the account's catalog while its discovery runs"
  )
  assert.deepEqual(borrowed.models, profile.models)
  assert.equal(borrowed.available, true)
  assert.equal(
    borrowed.settings,
    undefined,
    "Workspace defaults are never borrowed from another workspace"
  )
  assert.equal(loads, 2, "The borrowed answer does not stand in for discovery")
  freshGate.resolve()
  hold = null
  await until(() => reported.length >= 2)
  assert.deepEqual(reported, ["/one", "/fresh"])
  const settled = await harnessProfile(profile.id, false, "/fresh")
  assert.equal(settled.pending, undefined)
  assert.deepEqual(settled.settings, profile.settings)
  account = "persisted"
  const persistedGate = Promise.withResolvers<void>()
  hold = persistedGate.promise
  nearest.mock.mockImplementationOnce(async () => profile)
  const recalled = await harnessProfile(profile.id, false, "/anywhere")
  assert.equal(recalled.pending, true, "The persisted cache serves an account's catalog across host restarts")
  assert.deepEqual(recalled.models, profile.models)
  assert.equal(recalled.settings, undefined)
  persistedGate.resolve()
  hold = null
  await until(() => reported.length >= 3)
  assert.equal(loads, 3)
  account = "cold"
  const cold = await harnessProfile(profile.id, false, "/cold")
  assert.equal(cold.pending, undefined, "Without any account snapshot, display waits for discovery")
  await until(() => reported.length >= 4)
  assert.equal(loads, 4)
  account = "one"
  now += 60_000
  await harnessProfileForSend(profile.id, "/one")
  assert.equal(
    loads,
    4,
    "Sending does not run discovery again after the display TTL"
  )
  const stale = await harnessProfile(profile.id, false, "/one")
  assert.equal(
    stale.pending,
    undefined,
    "An expired profile is served, not withheld"
  )
  assert.equal(loads, 5, "Ordinary discovery still refreshes expired profiles")
  await until(() => reported.length >= 5)
  assert.equal(reported.length, 5, "The refresh behind a stale answer reports")
  await harnessProfile(profile.id, true, "/one")
  assert.equal(loads, 6, "Explicit refresh stays authoritative")
  await harnessProfileForSend(profile.id, "/two")
  assert.equal(
    loads,
    7,
    "A different workspace cannot borrow the cached settings"
  )
  account = "two"
  await harnessProfileForSend(profile.id, "/one")
  assert.equal(
    loads,
    8,
    "A different account cannot borrow the cached settings"
  )
  const loader = providerHost.profiles.get(profile.id)
  assert.ok(loader)
  const launchGate = Promise.withResolvers<void>()
  let launchLoads = 0
  const launchProfile: HarnessProfile = {
    ...profile,
    models: [
      {
        id: "fixture-model",
        label: "Fixture",
        options: [
          {
            kind: "select",
            id: "effort",
            label: "Effort",
            values: [{ value: "low", label: "Low" }],
          },
        ],
      },
    ],
  }
  loader.loadForSend = async () => {
    launchLoads++
    await launchGate.promise
    return launchProfile
  }
  account = "launch-one"
  const beforeReports = reported.length
  const first = resolveHarnessLaunch(profile.id, "/one", {
    model: "fixture-model",
    options: { effort: "low" },
  })
  const duplicate = resolveHarnessLaunch(profile.id, "/one", {
    model: "fixture-model",
  })
  await until(() => launchLoads >= 1)
  assert.equal(
    launchLoads,
    1,
    "Concurrent launches share a scoped catalogue query"
  )
  account = "launch-two"
  const otherAccount = resolveHarnessLaunch(profile.id, "/one", {
    model: "fixture-model",
  })
  const otherWorkspace = resolveHarnessLaunch(profile.id, "/two", {
    model: "fixture-model",
  })
  await until(() => launchLoads >= 3)
  assert.equal(
    launchLoads,
    3,
    "Launch catalogues stay isolated by account and workspace"
  )
  launchGate.resolve()
  await Promise.all([first, duplicate, otherAccount, otherWorkspace])
  assert.equal(
    reported.length,
    beforeReports,
    "Launch-only data must not replace the full displayed profile"
  )
  await assert.rejects(
    resolveHarnessLaunch(profile.id, "/one", {
      model: "fixture-model",
      options: { effort: "invalid" },
    }),
    /not supported/
  )
  const root = await mkdtemp(join(tmpdir(), "mako-profile-alias-"))
  try {
    const directory = join(root, "workspace")
    const alias = join(root, "alias")
    await mkdir(directory)
    await symlink(directory, alias, "junction")
    account = "aliased-workspace"
    await harnessProfile(profile.id, true, directory)
    const before = launchLoads
    assert.equal(await harnessProfileForSend(profile.id, alias), profile)
    assert.equal(
      launchLoads,
      before,
      "A workspace alias reuses the validated profile rather than starting another CLI"
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
  loader.nativeModelIds = true
  const beforeNativeSelection = launchLoads
  const nativeSelection = { model: "provider-native-id", options: {} }
  assert.equal(
    await resolveHarnessLaunch(
      profile.id,
      "/native-selection",
      nativeSelection
    ),
    nativeSelection
  )
  assert.equal(
    launchLoads,
    beforeNativeSelection,
    "Provider-native model-only selections need no catalogue translation"
  )
  await assert.rejects(
    resolveHarnessLaunch(profile.id, "/native-selection", {
      model: "fixture-model",
      options: { effort: "invalid" },
    }),
    /not supported/
  )
  const unavailable = { ...profile, available: false, error: "Provider is not signed in", models: [] }
  loader.loadForSend = async () => unavailable
  account = "unavailable-model-catalogue"
  await assert.rejects(resolveHarnessLaunch(profile.id, "/unavailable", { model: "model-family", options: { effort: "high" } }), /not signed in/)

  // A discovery that fails after it has succeeded keeps the account's models
  // and says why; the failure is held briefly and never persisted.
  account = "flaky"
  const good = await harnessProfile(profile.id, true, "/flaky")
  assert.equal(good.available, true)
  const persisted = persist.mock.callCount()
  failWith = new Error("cursor-agent discovery timed out during cursor/list_available_models after 30000 ms")
  const kept = await harnessProfile(profile.id, true, "/flaky")
  assert.equal(kept.available, true, "the last discovered models still answer")
  assert.deepEqual(kept.models, profile.models)
  assert.match(kept.configurationError ?? "", /timed out.*Showing the last discovered settings/)
  assert.equal(persist.mock.callCount(), persisted, "a failed discovery is never persisted")
  const beforeRetry = loads
  const reportedBefore = reported.length
  await harnessProfile(profile.id, false, "/flaky")
  assert.equal(loads, beforeRetry, "the failure is held for a moment")
  now += FAILED_DISCOVERY_TTL_MS + 1
  failWith = null
  const stillKept = await harnessProfile(profile.id, false, "/flaky")
  assert.equal(stillKept.configurationError, kept.configurationError, "stale beats blank while discovery reruns")
  assert.equal(loads, beforeRetry + 1, "an expired failure reruns discovery")
  await until(() => reported.length > reportedBefore)
  const recovered = await harnessProfile(profile.id, false, "/flaky")
  assert.equal(recovered.configurationError, undefined, "the rerun clears the failure")
  // A send during the failure validates against the last catalogue at once
  // instead of waiting on another 30 s discovery, and retries it behind.
  delete loader.nativeModelIds
  failWith = new Error("cursor-agent discovery timed out during cursor/list_available_models after 30000 ms")
  await harnessProfile(profile.id, true, "/flaky")
  now += FAILED_DISCOVERY_TTL_MS + 1
  failWith = null
  const sendLoads = loads
  const reportedBeforeSend = reported.length
  const sendGate = Promise.withResolvers<void>()
  hold = sendGate.promise
  const sent = await Promise.race([
    resolveHarnessLaunch(profile.id, "/flaky", { model: "account-model" }),
    new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 200)),
  ])
  assert.deepEqual(sent, { model: "account-model" }, "a send never waits on a refresh while a catalogue is known")
  assert.equal(loads, sendLoads + 1, "the failed catalogue is retried behind the send")
  sendGate.resolve()
  hold = null
  await until(() => reported.length > reportedBeforeSend)
  const healed = await harnessProfileForSend(profile.id, "/flaky")
  assert.equal(healed.configurationError, undefined, "the retry behind the send heals the profile")
  assert.equal(loads, sendLoads + 1, "a healthy stale catalogue is not refreshed per send")
  // With nothing ever discovered for the account, the failure is the answer.
  account = "never-discovered"
  failWith = new Error("spawn ENOENT")
  const blank = await harnessProfile(profile.id, true, "/never")
  assert.equal(blank.available, false)
  assert.match(blank.error ?? "", /ENOENT/)
  failWith = null
  console.log(
    "Send discovery: native defaults and native IDs avoid discovery; a new workspace borrows the account's catalog; option validation, concurrent launches, account/workspace isolation, aliases, and full profile updates are preserved"
  )
} finally {
  stopReporting()
  only.mock.restore()
  clock.mock.restore()
  persist.mock.restore()
  recall.mock.restore()
  nearest.mock.restore()
}
