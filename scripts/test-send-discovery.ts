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
  refreshHarnessProfiles,
} from "../electron/harnesses.js"
import type { HarnessProfile } from "../electron/shared.js"

const workspaceRoot = await mkdtemp(join(tmpdir(), "mako-send-discovery-"))
const workspace = (name: string) => join(workspaceRoot, name)
await Promise.all(["anywhere", "cold", "flaky", "fresh", "native-selection", "never", "one", "two", "unavailable"].map(name => mkdir(workspace(name))))

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
  defaults: { work: [], light: [] },
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
    await resolveHarnessLaunch(profile.id, workspace("one"), undefined),
    undefined
  )
  const nativeOptions = { options: { effort: "high" } }
  assert.equal(
    await resolveHarnessLaunch(profile.id, workspace("one"), nativeOptions),
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
  const immediate = harnessProfilesNow(workspace("one")).then((profiles) => {
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
  assert.deepEqual(reported, [workspace("one")], "Discovery reports through the event")
  const freshGate = Promise.withResolvers<void>()
  hold = freshGate.promise
  const borrowed = await harnessProfile(profile.id, false, workspace("fresh"))
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
  assert.deepEqual(reported, [workspace("one"), workspace("fresh")])
  const settled = await harnessProfile(profile.id, false, workspace("fresh"))
  assert.equal(settled.pending, undefined)
  assert.deepEqual(settled.settings, profile.settings)
  account = "persisted"
  const persistedGate = Promise.withResolvers<void>()
  hold = persistedGate.promise
  nearest.mock.mockImplementationOnce(async () => profile)
  const recalled = await harnessProfile(profile.id, false, workspace("anywhere"))
  assert.equal(recalled.pending, true, "The persisted cache serves an account's catalog across host restarts")
  assert.deepEqual(recalled.models, profile.models)
  assert.equal(recalled.settings, undefined)
  persistedGate.resolve()
  hold = null
  await until(() => reported.length >= 3)
  assert.equal(loads, 3)
  account = "cold"
  const cold = await harnessProfile(profile.id, false, workspace("cold"))
  assert.equal(cold.pending, undefined, "Without any account snapshot, display waits for discovery")
  await until(() => reported.length >= 4)
  assert.equal(loads, 4)
  account = "one"
  now += 60_000
  await harnessProfileForSend(profile.id, workspace("one"))
  assert.equal(
    loads,
    4,
    "Sending does not run discovery again after the display TTL"
  )
  const stale = await harnessProfile(profile.id, false, workspace("one"))
  assert.equal(
    stale.pending,
    undefined,
    "An expired profile is served, not withheld"
  )
  assert.equal(loads, 5, "Ordinary discovery still refreshes expired profiles")
  await until(() => reported.length >= 5)
  assert.equal(reported.length, 5, "The refresh behind a stale answer reports")
  await harnessProfile(profile.id, true, workspace("one"))
  assert.equal(loads, 6, "Explicit refresh stays authoritative")
  await harnessProfileForSend(profile.id, workspace("two"))
  assert.equal(
    loads,
    7,
    "A different workspace cannot borrow the cached settings"
  )
  account = "two"
  await harnessProfileForSend(profile.id, workspace("one"))
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
  const first = resolveHarnessLaunch(profile.id, workspace("one"), {
    model: "fixture-model",
    options: { effort: "low" },
  })
  const duplicate = resolveHarnessLaunch(profile.id, workspace("one"), {
    model: "fixture-model",
  })
  await until(() => launchLoads >= 1)
  assert.equal(
    launchLoads,
    1,
    "Concurrent launches share a scoped catalogue query"
  )
  account = "launch-two"
  const otherAccount = resolveHarnessLaunch(profile.id, workspace("one"), {
    model: "fixture-model",
  })
  const otherWorkspace = resolveHarnessLaunch(profile.id, workspace("two"), {
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
    resolveHarnessLaunch(profile.id, workspace("one"), {
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
      workspace("native-selection"),
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
    resolveHarnessLaunch(profile.id, workspace("native-selection"), {
      model: "fixture-model",
      options: { effort: "invalid" },
    }),
    /not supported/
  )
  const unavailable = { ...profile, available: false, error: "Provider is not signed in", models: [] }
  loader.loadForSend = async () => unavailable
  account = "unavailable-model-catalogue"
  await assert.rejects(resolveHarnessLaunch(profile.id, workspace("unavailable"), { model: "model-family", options: { effort: "high" } }), /not signed in/)

  // A discovery that fails after it has succeeded keeps the account's models
  // and says why; the failure is held briefly and never persisted.
  account = "flaky"
  const good = await harnessProfile(profile.id, true, workspace("flaky"))
  assert.equal(good.available, true)
  const persisted = persist.mock.callCount()
  failWith = new Error("cursor-agent discovery timed out during cursor/list_available_models after 30000 ms")
  const kept = await harnessProfile(profile.id, true, workspace("flaky"))
  assert.equal(kept.available, true, "the last discovered models still answer")
  assert.deepEqual(kept.models, profile.models)
  assert.match(kept.configurationError ?? "", /timed out.*Showing the last discovered settings/)
  assert.equal(persist.mock.callCount(), persisted, "a failed discovery is never persisted")
  const beforeRetry = loads
  const reportedBefore = reported.length
  await harnessProfile(profile.id, false, workspace("flaky"))
  assert.equal(loads, beforeRetry, "the failure is held for a moment")
  now += FAILED_DISCOVERY_TTL_MS + 1
  failWith = null
  const stillKept = await harnessProfile(profile.id, false, workspace("flaky"))
  assert.equal(stillKept.configurationError, kept.configurationError, "stale beats blank while discovery reruns")
  assert.equal(loads, beforeRetry + 1, "an expired failure reruns discovery")
  await until(() => reported.length > reportedBefore)
  const recovered = await harnessProfile(profile.id, false, workspace("flaky"))
  assert.equal(recovered.configurationError, undefined, "the rerun clears the failure")
  // A send during the failure validates against the last catalogue at once
  // instead of waiting on another 30 s discovery, and retries it behind.
  delete loader.nativeModelIds
  failWith = new Error("cursor-agent discovery timed out during cursor/list_available_models after 30000 ms")
  await harnessProfile(profile.id, true, workspace("flaky"))
  now += FAILED_DISCOVERY_TTL_MS + 1
  failWith = null
  const sendLoads = loads
  const reportedBeforeSend = reported.length
  const sendGate = Promise.withResolvers<void>()
  hold = sendGate.promise
  const sent = await Promise.race([
    resolveHarnessLaunch(profile.id, workspace("flaky"), { model: "account-model" }),
    new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 200)),
  ])
  assert.deepEqual(sent, { model: "account-model" }, "a send never waits on a refresh while a catalogue is known")
  assert.equal(loads, sendLoads + 1, "the failed catalogue is retried behind the send")
  sendGate.resolve()
  hold = null
  await until(() => reported.length > reportedBeforeSend)
  const healed = await harnessProfileForSend(profile.id, workspace("flaky"))
  assert.equal(healed.configurationError, undefined, "the retry behind the send heals the profile")
  assert.equal(loads, sendLoads + 1, "a healthy stale catalogue is not refreshed per send")
  // With nothing ever discovered for the account, the failure is the answer.
  account = "never-discovered"
  failWith = new Error("spawn ENOENT")
  const blank = await harnessProfile(profile.id, true, workspace("never"))
  assert.equal(blank.available, false)
  assert.match(blank.error ?? "", /ENOENT/)
  failWith = null
  // The same revision fence protects every registered family and a future
  // adapter. All native discovery here is replaced by controlled loaders.
  for (const family of [...providerHost.liveDrivers.list().map(driver => driver.provider), "future-harness"]) {
    const id = `refresh-fixture-${family}`
    const oldGate = Promise.withResolvers<HarnessProfile>()
    const latestGate = Promise.withResolvers<HarnessProfile>()
    const oldSendGate = Promise.withResolvers<HarnessProfile>()
    const latestSendGate = Promise.withResolvers<HarnessProfile>()
    let calls = 0
    let sendCalls = 0
    let accountScope = "display"
    const displaySignals: AbortSignal[] = []
    const sendSignals: AbortSignal[] = []
    const newest = { ...profile, id, models: [{ id: "new-runtime", label: "New", options: [] }] }
    const obsolete = { ...newest, models: [{ id: "old-runtime", label: "Old", options: [] }] }
    const unregister = providerHost.profiles.register({
      provider: id, label: family, transport: "sdk", defaults: { work: [], light: [] }, capabilities: [],
      cacheKey: () => accountScope,
      load: async (_env, _cwd, context) => {
        assert.ok(context)
        displaySignals.push(context.signal)
        calls++
        if (accountScope === "send") return { ...newest, available: false, models: [] }
        return calls === 1 ? oldGate.promise : calls === 2 ? latestGate.promise : newest
      },
      loadForSend: async (_env, _cwd, context) => {
        assert.ok(context)
        sendSignals.push(context.signal)
        return ++sendCalls === 1 ? oldSendGate.promise : latestSendGate.promise
      },
    })
    const published: string[] = []
    const unlisten = onHarnessProfile(event => { if (event.profile.id === id) published.push(event.profile.models[0]!.id) })
    try {
      const oldRequest = harnessProfile(id, true, workspace("one"))
      const obsoleteRejected = assert.rejects(oldRequest, /superseded/)
      await until(() => calls === 1)
      const refresh = refreshHarnessProfiles(id)
      await until(() => calls === 2)
      assert.equal(displaySignals[0]!.aborted, true, `${family}: refresh cancels the obsolete display owner`)
      assert.equal(displaySignals[1]!.aborted, false, `${family}: refresh cannot cancel its replacement`)
      oldGate.resolve(obsolete)
      await obsoleteRejected
      // A normal consumer joins the replacement or reads its completed cache.
      // A second forced refresh is allowed to start another query if realpath
      // finishes after the first one, so it cannot prove single publication.
      const joined = harnessProfile(id, false, workspace("one"))
      await settle()
      assert.equal(calls, 2, `${family}: stale completion cannot delete the new request`)
      latestGate.resolve(newest)
      await refresh
      assert.equal((await joined).models[0]!.id, "new-runtime")
      assert.equal(calls, 2, `${family}: a consumer joins discovery or reads its completed cache`)
      assert.deepEqual(published, ["new-runtime"], `${family}: obsolete results cannot publish`)
      assert.equal((await harnessProfileForSend(id, workspace("one"))).models[0]!.id, "new-runtime")
      accountScope = "send"
      const oldSend = harnessProfileForSend(id, workspace("one"))
      const oldSendRejected = assert.rejects(oldSend, /superseded/)
      await until(() => sendCalls === 1)
      await refreshHarnessProfiles(id)
      assert.equal(sendSignals[0]!.aborted, true, `${family}: refresh cancels obsolete send discovery`)
      now += 31_000
      const newSend = harnessProfileForSend(id, workspace("one"))
      await until(() => sendCalls === 2)
      assert.equal(sendSignals[1]!.aborted, false, `${family}: a new send receives a live owner`)
      oldSendGate.resolve(obsolete)
      await oldSendRejected
      const joinedSend = harnessProfileForSend(id, workspace("one"))
      await settle()
      assert.equal(sendCalls, 2, `${family}: stale send discovery cannot delete its replacement`)
      latestSendGate.resolve(newest)
      assert.equal((await newSend).models[0]!.id, "new-runtime")
      assert.equal((await joinedSend).models[0]!.id, "new-runtime")
    } finally {
      unlisten()
      unregister()
    }
  }
  console.log(
    "Send discovery: native defaults and native IDs avoid discovery; a new workspace borrows the account's catalog; option validation, concurrent launches, account/workspace isolation, aliases, and full profile updates are preserved"
  )
} finally {
  await rm(workspaceRoot, { recursive: true, force: true })
  stopReporting()
  only.mock.restore()
  clock.mock.restore()
  persist.mock.restore()
  recall.mock.restore()
  nearest.mock.restore()
}
