import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { mock } from "node:test"
import { mkdtemp, mkdir, readFile, symlink, rm, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { z } from "zod"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { ProviderProfileCache } from "@mako/host/harnesses/provider-profile-cache"
import { ASKED_AGAIN_MS, DISPLAY_TTL_MS, FAILED_DISCOVERY_MAX_MS, FAILED_DISCOVERY_TTL_MS, HarnessProfiles } from "@mako/host/harnesses/harness-profiles"
import { Foreground } from "@mako/host/base/foreground"
import type { HarnessProfile } from "@mako/host/contracts/providers-acp"
import type { SessionModel } from "@mako/sessions/settings"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

const nativeStores = new NativeStores(false)

const providerHost = createHarnessHost(detachedHarnessContext(nativeStores))

const workspaceRoot = await mkdtemp(join(tmpdir(), "mako-send-discovery-"))
const workspace = (name: string) => join(workspaceRoot, name)
const storePath = join(workspaceRoot, "provider-profiles.json")
const foreground = new Foreground()
const profiles = new HarnessProfiles(providerHost, new ProviderProfileCache(storePath), foreground)
const folders = ["anywhere", "busy", "cold", "fin-one", "fin-two", "flaky", "fresh", "kept", "native-selection", "never", "one", "restarted-fin", "two", "unavailable"]
await Promise.all(folders.map(name => mkdir(workspace(name))))

let account = "one"
let loads = 0
/** Real discovery takes seconds; hold the fixture open to observe what answers meanwhile. */
let hold: Promise<void> | null = null
/** The CLI's failure of the moment: a timed-out model listing, a crash. */
let failWith: Error | null = null
/** The runtime the fixture harness says it is, and what each discovery was handed from the last. */
let stamp: string | undefined
const handed: (readonly SessionModel[] | undefined)[] = []
const profile: HarnessProfile = {
  id: "queue-profile-test",
  label: "Test",
  available: true,
  transport: "sdk",
  models: [{ id: "account-model", label: "Account model", options: [{ kind: "select", id: "effort", label: "Effort", values: [{ value: "low", label: "Low" }] }] }],
  settings: { model: "account-model" },
}
/** What the fixture harness lists now. */
let listed = profile
providerHost.profiles.register({
  provider: profile.id,
  label: "Test",
  defaults: { work: [] },
  transport: "sdk",
  cacheKey: () => account,
  runtimeStamp: async () => stamp,
  load: async (_env, _cwd, context) => {
    loads++
    handed.push(context?.kept)
    if (hold) await hold
    if (failWith) throw failWith
    return listed
  },
})
const originalTime = Date.now()
let now = originalTime
const clock = mock.method(Date, "now", () => now)
const reported: (string | undefined)[] = []
const stopReporting = profiles.onProfile((event) => {
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
/** Long enough for a discovery that should not start to have started. */
const quiet = async () => { for (let turn = 0; turn < 5; turn++) await settle() }
try {
  assert.equal(
    await profiles.resolveLaunch(profile.id, workspace("one"), undefined),
    undefined
  )
  const nativeOptions = { options: { effort: "high" } }
  assert.equal(
    await profiles.resolveLaunch(profile.id, workspace("one"), nativeOptions),
    nativeOptions
  )
  assert.equal(
    loads,
    0,
    "Native defaults and model-free options cannot wait for model discovery"
  )

  // A window's start and the heartbeat read what is held, and nothing is held yet.
  const blankBoot = await profiles.snapshots(workspace("one"))
  await quiet()
  assert.ok(blankBoot.some((entry) => entry.id === profile.id && entry.pending && entry.models.length === 0), "A harness nothing is held for is a pending placeholder")
  assert.equal(loads, 0, "A window's start discovers nothing, even with nothing held")

  // A read with nothing held is the one read that waits for its discovery.
  const first = await profiles.get(profile.id, false, workspace("one"))
  assert.deepEqual(first, profile)
  assert.equal(loads, 1)
  assert.deepEqual(reported, [workspace("one")], "Discovery reports through the event")
  for (let read = 0; read < 3; read++) await profiles.get(profile.id, false, workspace("one"))
  now += 31_000
  await profiles.get(profile.id, false, workspace("one"))
  await quiet()
  assert.equal(loads, 1, "A read no longer discovers after 30 s: the list answers for hours")
  const boot = await profiles.snapshots(workspace("one"))
  assert.deepEqual(boot, [profile], "A window's start answers what is held, in the reply itself")
  assert.equal(boot[0]?.stale, undefined)

  // A folder the account was never discovered in lists the account's models and starts nothing.
  const borrowed = await profiles.get(profile.id, false, workspace("fresh"))
  assert.equal(borrowed.pending, undefined, "The account's models are shown, not a placeholder")
  assert.deepEqual(borrowed.models, profile.models)
  assert.equal(borrowed.available, true)
  assert.equal(borrowed.settings, undefined, "Workspace defaults are never borrowed from another workspace")
  // A Fin starts in a worktree of its own: the account's list validates it at once.
  const fin = await profiles.forSend(profile.id, workspace("fin-one"))
  assert.deepEqual(fin.models, profile.models)
  assert.equal(fin.settings, undefined)
  assert.deepEqual(await profiles.resolveLaunch(profile.id, workspace("fin-two"), { model: "account-model" }), { model: "account-model" })
  await quiet()
  assert.equal(loads, 1, "A new folder of a known account is no reason to discover")
  assert.deepEqual(reported, [workspace("one")])

  // Opening the picker is a person asking: the folder is discovered, once however often it opens in a minute.
  const asked = await profiles.get(profile.id, true, workspace("fresh"))
  assert.deepEqual(asked.settings, profile.settings, "The folder's own discovery reports its own defaults")
  assert.equal(loads, 2, "Opening the picker asks the harness")
  await profiles.get(profile.id, true, workspace("fresh"))
  assert.equal(loads, 2, "Opening it again at once does not")
  now += ASKED_AGAIN_MS + 1
  await profiles.get(profile.id, true, workspace("fresh"))
  assert.equal(loads, 3, "Opening it later does")
  assert.deepEqual(reported, [workspace("one"), workspace("fresh"), workspace("fresh")])

  // The next host starts with nothing in memory and the snapshot on disk.
  const restarted = new HarnessProfiles(providerHost, new ProviderProfileCache(storePath), foreground)
  try {
    const restartedBoot = await restarted.snapshots(workspace("one"))
    assert.deepEqual(restartedBoot, [profile], "The next host's windows paint the snapshot")
    assert.deepEqual(await restarted.resolveLaunch(profile.id, workspace("one"), { model: "account-model" }), { model: "account-model" })
    assert.deepEqual((await restarted.forSend(profile.id, workspace("one"))).settings, profile.settings, "A folder's own defaults come back with it")
    const restartedFin = await restarted.forSend(profile.id, workspace("restarted-fin"))
    assert.deepEqual(restartedFin.models, profile.models, "A Fin's new worktree lists the account's models from disk")
    assert.equal(restartedFin.settings, undefined)
    assert.deepEqual(restarted.held(profile.id)?.models, profile.models, "Rows read their labels from the snapshot")
    await quiet()
    assert.equal(loads, 3, "After a restart a send, a Fin's start, a window's start and the heartbeat discover nothing")
    await assert.rejects(restarted.resolveLaunch(profile.id, workspace("one"), { model: "account-model", options: { effort: "invalid" } }), /not supported/, "The snapshot refuses what it does not list")
    await until(() => loads === 4)
    assert.equal(loads, 4, "A send the catalogue refused asks the harness again behind the refusal")
    await until(() => reported.length === 3)

    // Nothing of one account answers for another.
    account = "two"
    const otherBoot = await restarted.snapshots(workspace("one"))
    assert.equal(otherBoot[0]?.pending, true, "Another account has no snapshot to paint")
    assert.equal(otherBoot[0]?.models.length, 0, "and never the first account's models")
    await quiet()
    assert.equal(loads, 4)
    listed = { ...profile, models: [{ id: "second-account-model", label: "Second", options: [] }], settings: { model: "second-account-model" } }
    const otherSend = await restarted.forSend(profile.id, workspace("one"))
    assert.deepEqual(otherSend.models.map((model) => model.id), ["second-account-model"], "A send validates against its own account's list, never another's")
    assert.equal(loads, 5, "With nothing held for the account, a send waits for its discovery")
    listed = profile
    account = "one"
  } finally {
    await restarted.stop()
  }

  // The list is refreshed behind a read once it is hours old, and the read does not wait for it.
  const loadsBeforeStale = loads
  const reportsBeforeStale = reported.length
  now += DISPLAY_TTL_MS + 1
  const staleGate = Promise.withResolvers<void>()
  hold = staleGate.promise
  assert.equal((await profiles.snapshots(workspace("one")))[0]?.stale, true, "A snapshot past its freshness says so")
  await quiet()
  assert.equal(loads, loadsBeforeStale, "and a window's start still discovers nothing")
  const stale = await profiles.forSend(profile.id, workspace("one"))
  assert.deepEqual(stale.models, profile.models, "A send is answered by the old list")
  await until(() => loads === loadsBeforeStale + 1)
  await profiles.get(profile.id, false, workspace("one"))
  await profiles.forSend(profile.id, workspace("fresh"))
  await quiet()
  assert.equal(loads, loadsBeforeStale + 1, "One refresh runs behind every read of the account")
  staleGate.resolve()
  hold = null
  await until(() => reported.length > reportsBeforeStale)
  await profiles.get(profile.id, false, workspace("fresh"))
  await quiet()
  assert.equal(loads, loadsBeforeStale + 1, "The refreshed list is every folder's")

  // A discovery nobody waits for starts once the host's foreground is free.
  now += DISPLAY_TTL_MS + 1
  const release = foreground.hold("a harness starting")
  const busyLoads = loads
  await profiles.forSend(profile.id, workspace("busy"))
  await quiet()
  assert.equal(loads, busyLoads, "No discovery starts behind a start")
  release()
  await until(() => loads === busyLoads + 1)
  await until(() => reported.at(-1) === workspace("busy"))
  // A person who asks while one waits its turn is not kept waiting behind the start: the same discovery runs now.
  now += DISPLAY_TTL_MS + 1
  const releaseAgain = foreground.hold("a harness starting")
  await profiles.forSend(profile.id, workspace("busy"))
  await quiet()
  assert.equal(loads, busyLoads + 1)
  const askedWhileBusy = await Promise.race([profiles.get(profile.id, true, workspace("busy")), new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 300))])
  assert.notEqual(askedWhileBusy, "waited", "a caller that waits on a discovery never waits for the foreground it may itself hold")
  assert.equal(loads, busyLoads + 2, "and it is the one discovery, not a second")
  releaseAgain()

  // A runtime that changed is discovered once, in the folder last read, and every folder hears the new list.
  listed = { ...profile, models: [...profile.models, { id: "released-model", label: "Released", options: [] }] }
  const refreshLoads = loads
  const refreshReports = reported.length
  await profiles.refresh(profile.id)
  assert.equal(loads, refreshLoads + 1, "A changed runtime is one discovery for the account, not one per folder")
  assert.ok((await profiles.forSend(profile.id, workspace("one"))).models.some((model) => model.id === "released-model"), "Another folder sends with the new list")
  assert.deepEqual((await profiles.forSend(profile.id, workspace("one"))).settings, profile.settings, "and keeps its own defaults")
  assert.ok(reported.slice(refreshReports).includes(workspace("one")), "A folder whose list changed hears it")
  assert.equal(loads, refreshLoads + 1)
  listed = profile
  await profiles.refresh(profile.id)
  assert.equal(loads, refreshLoads + 2, "A connection that changed discovers again the same way")
  assert.deepEqual((await profiles.forSend(profile.id, workspace("fin-one"))).models.map((model) => model.id), ["account-model"], "A model the harness stopped listing is gone from what a Fin's start is held to once the refresh landed")

  // What a harness said of each model stands for its runtime and account.
  account = "kept"
  stamp = "runtime-1"
  handed.length = 0
  await profiles.get(profile.id, true, workspace("kept"))
  now += ASKED_AGAIN_MS + 1
  await profiles.get(profile.id, true, workspace("kept"))
  stamp = "runtime-2"
  now += ASKED_AGAIN_MS + 1
  await profiles.get(profile.id, true, workspace("kept"))
  assert.deepEqual(handed, [undefined, profile.models, undefined], "A discovery is handed the last one's models only under the same runtime")
  stamp = undefined

  account = "cold"
  const coldLoads = loads
  const cold = await profiles.get(profile.id, false, workspace("cold"))
  assert.equal(cold.pending, undefined, "Without any account snapshot, display waits for discovery")
  assert.equal(loads, coldLoads + 1)

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
    settings: { model: "fixture-model" },
  }
  listed = launchProfile
  loader.loadForSend = async () => {
    launchLoads++
    await launchGate.promise
    return launchProfile
  }
  account = "launch-one"
  const launchFullLoads = loads
  const firstLaunch = profiles.resolveLaunch(profile.id, workspace("one"), {
    model: "fixture-model",
    options: { effort: "low" },
  })
  const duplicate = profiles.resolveLaunch(profile.id, workspace("one"), {
    model: "fixture-model",
  })
  await until(() => launchLoads >= 1)
  await quiet()
  assert.equal(
    launchLoads,
    1,
    "Concurrent launches share a scoped catalogue query"
  )
  assert.equal(loads, launchFullLoads + 1, "and one whole discovery behind them, so the next send finds the profile held")
  account = "launch-two"
  const otherAccount = profiles.resolveLaunch(profile.id, workspace("one"), {
    model: "fixture-model",
  })
  await until(() => launchLoads >= 2)
  assert.equal(launchLoads, 2, "Launch catalogues stay isolated by account")
  launchGate.resolve()
  await Promise.all([firstLaunch, duplicate, otherAccount])
  await until(() => loads === launchFullLoads + 2)
  await profiles.resolveLaunch(profile.id, workspace("two"), { model: "fixture-model" })
  assert.equal(launchLoads, 2, "A later send in another folder of the account asks nothing")
  await assert.rejects(
    profiles.resolveLaunch(profile.id, workspace("one"), {
      model: "fixture-model",
      options: { effort: "invalid" },
    }),
    /not supported/
  )
  await quiet()
  const root = await mkdtemp(join(tmpdir(), "mako-profile-alias-"))
  try {
    const directory = join(root, "workspace")
    const alias = join(root, "alias")
    await mkdir(directory)
    await symlink(directory, alias, "junction")
    account = "aliased-workspace"
    const direct = await profiles.get(profile.id, true, directory)
    const before = launchLoads
    assert.equal(await profiles.forSend(profile.id, alias), direct)
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
    await profiles.resolveLaunch(
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
    profiles.resolveLaunch(profile.id, workspace("native-selection"), {
      model: "fixture-model",
      options: { effort: "invalid" },
    }),
    /not supported/
  )
  await quiet()
  listed = profile
  const unavailable = { ...profile, available: false, error: "Provider is not signed in", models: [] }
  loader.loadForSend = async () => unavailable
  account = "unavailable-model-catalogue"
  await assert.rejects(profiles.resolveLaunch(profile.id, workspace("unavailable"), { model: "model-family", options: { effort: "high" } }), /not signed in/)
  await quiet()
  delete loader.loadForSend

  // A discovery that fails after it has succeeded keeps the account's models
  // and says why; the failure is held, longer each time, and never persisted.
  account = "flaky"
  const good = await profiles.get(profile.id, true, workspace("flaky"))
  assert.equal(good.available, true)
  now += ASKED_AGAIN_MS + 1
  failWith = new Error("cursor-agent discovery timed out during cursor/list_available_models after 30000 ms")
  const kept = await profiles.get(profile.id, true, workspace("flaky"))
  assert.equal(kept.available, true, "the last discovered models still answer")
  assert.deepEqual(kept.models, profile.models)
  assert.match(kept.configurationError ?? "", /timed out.*Showing the last discovered settings/)
  const afterFailure = new HarnessProfiles(providerHost, new ProviderProfileCache(storePath))
  assert.equal((await afterFailure.snapshots(workspace("flaky")))[0]?.configurationError, undefined, "a failed discovery is never persisted")
  await afterFailure.stop()
  let failedLoads = loads
  await profiles.get(profile.id, false, workspace("flaky"))
  await quiet()
  assert.equal(loads, failedLoads, "the failure is held for a moment")
  // Each failure doubles the hold: 5 s, 10 s, 20 s and on to the cap.
  for (const held of [FAILED_DISCOVERY_TTL_MS, FAILED_DISCOVERY_TTL_MS * 2, FAILED_DISCOVERY_TTL_MS * 4]) {
    now += held - 1
    await profiles.get(profile.id, false, workspace("flaky"))
    await quiet()
    assert.equal(loads, failedLoads, `a failure is left alone for ${held} ms`)
    now += 2
    const reportedBefore = reported.length
    const stillKept = await profiles.get(profile.id, false, workspace("flaky"))
    assert.equal(stillKept.configurationError, kept.configurationError, "stale beats blank while discovery reruns")
    await until(() => reported.length > reportedBefore)
    assert.equal(loads, ++failedLoads, "an expired failure reruns discovery, once")
  }
  now += FAILED_DISCOVERY_MAX_MS - 1
  for (let read = 0; read < 3; read++) await profiles.get(profile.id, false, workspace("flaky"))
  await quiet()
  assert.equal(loads, failedLoads + 1, "however long it has failed, a read asks again within the cap")
  await until(() => reported.at(-1) === workspace("flaky"))
  failedLoads = loads
  // A send during the failure validates against the last catalogue at once
  // instead of waiting on another 30 s discovery, and retries it behind.
  delete loader.nativeModelIds
  now += FAILED_DISCOVERY_MAX_MS + 1
  failWith = null
  const sendLoads = loads
  const reportedBeforeSend = reported.length
  const sendGate = Promise.withResolvers<void>()
  hold = sendGate.promise
  const sent = await Promise.race([
    profiles.resolveLaunch(profile.id, workspace("flaky"), { model: "account-model" }),
    new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 200)),
  ])
  assert.deepEqual(sent, { model: "account-model" }, "a send never waits on a refresh while a catalogue is known")
  assert.equal(loads, sendLoads + 1, "the failed catalogue is retried behind the send")
  sendGate.resolve()
  hold = null
  await until(() => reported.length > reportedBeforeSend)
  const healed = await profiles.forSend(profile.id, workspace("flaky"))
  assert.equal(healed.configurationError, undefined, "the retry behind the send heals the profile")
  assert.equal(loads, sendLoads + 1, "a healthy catalogue is not refreshed per send")
  // With nothing ever discovered for the account, the failure is the answer.
  account = "never-discovered"
  failWith = new Error("spawn ENOENT")
  const blank = await profiles.get(profile.id, true, workspace("never"))
  assert.equal(blank.available, false)
  assert.match(blank.error ?? "", /ENOENT/)
  failWith = null
  // A harness that launches on what the folder configures: a send in a folder never discovered must not take
  // Mako's defaults in its place. Scratch repositories, a loader that reads its project file and counts its runs.
  {
    const id = "folder-profile-test"
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    const repo = workspace("repo")
    await mkdir(repo)
    git(repo, "init", "-q")
    git(repo, "config", "user.email", "test@example.invalid")
    git(repo, "config", "user.name", "Test")
    await writeFile(join(repo, "harness.json"), JSON.stringify({ model: "project-model" }))
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "project configuration")
    const worktree = (name: string, model?: string) => {
      const path = workspace(name)
      git(repo, "worktree", "add", "-q", "-b", name, path)
      if (model) writeFileSync(join(path, "harness.json"), JSON.stringify({ model }))
      return path
    }
    const models = ["project-model", "other-model", "parsed-model", "fallback-model"].map((model) => ({ id: model, label: model, options: [] }))
    const configured = z.object({ model: z.string() })
    const fieldsOf = async (cwd: string | undefined) => {
      const model = cwd ? await readFile(join(cwd, "harness.json"), "utf8").then((text) => configured.parse(JSON.parse(text)).model, () => "fallback-model") : "fallback-model"
      return { settings: { model }, configuredModel: model }
    }
    let folderLoads = 0
    let folderAccount = "repo-one"
    let folderHold: Promise<void> | null = null
    const folderLoader: Parameters<typeof providerHost.profiles.register>[0] = {
      provider: id, label: "Folder", transport: "sdk", defaults: { work: [] },
      cacheKey: () => folderAccount,
      folder: { files: ["harness.json"], configuredModel: true },
      load: async (_env, cwd) => {
        folderLoads++
        if (folderHold) await folderHold
        return { id, label: "Folder", available: true, transport: "sdk", models, ...await fieldsOf(cwd) }
      },
    }
    const unregister = providerHost.profiles.register(folderLoader)
    const landed: (string | undefined)[] = []
    const unlisten = profiles.onProfile((event) => { if (event.profile.id === id) landed.push(event.cwd) })
    try {
      const asked = await profiles.get(id, true, repo)
      assert.equal(asked.configuredModel, "project-model")
      assert.equal(folderLoads, 1)

      // A worktree of the same repository with the same project file is lent the folder's fields, and read behind.
      const same = worktree("wt-same")
      const lendGate = Promise.withResolvers<void>()
      folderHold = lendGate.promise
      const lent = await Promise.race([profiles.forSend(id, same), new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 300))])
      assert.notEqual(lent, "waited", "a send in a sibling worktree with the same project configuration waits for nothing")
      assert.ok(lent !== "waited")
      assert.equal(lent.configuredModel, "project-model", "it launches on the model the project configures")
      assert.deepEqual(lent.settings, { model: "project-model" })
      assert.deepEqual(await profiles.resolveLaunch(id, same, lent.settings), { model: "project-model" })
      lendGate.resolve()
      folderHold = null
      await until(() => landed.includes(same))
      assert.equal(folderLoads, 2, "its own configuration is read behind the send, once")
      assert.equal((await profiles.forSend(id, same)).configuredModel, "project-model")
      assert.equal(folderLoads, 2)

      // One whose project file differs is lent nothing: the send waits for that folder's own discovery.
      const differs = worktree("wt-differs", "other-model")
      const own = await profiles.forSend(id, differs)
      assert.equal(own.configuredModel, "other-model", "a worktree that configures another model launches on it")
      assert.equal(folderLoads, 3, "after one discovery")
      await profiles.forSend(id, differs)
      assert.equal(folderLoads, 3)

      // A display read in such a folder still starts nothing.
      const shownOnly = worktree("wt-shown", "other-model")
      const shown = await profiles.get(id, false, shownOnly)
      await quiet()
      assert.equal(shown.configuredModel, undefined)
      assert.equal(folderLoads, 3, "a display read of a new folder still discovers nothing")

      // A folder outside any repository has no sibling to ask.
      const plain = workspace("plain")
      await mkdir(plain)
      await writeFile(join(plain, "harness.json"), JSON.stringify({ model: "project-model" }))
      assert.equal((await profiles.forSend(id, plain)).configuredModel, "project-model")
      assert.equal(folderLoads, 4, "a send in a folder outside any repository, with nothing held for it, waits for one discovery")

      // Nothing is lent across accounts, though the folder and its file are the same.
      folderAccount = "repo-two"
      const elsewhere = workspace("plain-two")
      await mkdir(elsewhere)
      await profiles.get(id, true, elsewhere)
      assert.equal(folderLoads, 5)
      const otherAccount = worktree("wt-other-account")
      await profiles.forSend(id, otherAccount)
      assert.equal(folderLoads, 6, "another account's reading of the same repository is not this account's")
      folderAccount = "repo-one"

      // The next host lends from the snapshot on disk.
      const next = new HarnessProfiles(providerHost, new ProviderProfileCache(storePath))
      try {
        const restartGate = Promise.withResolvers<void>()
        folderHold = restartGate.promise
        const afterRestart = worktree("wt-restart")
        const lentFromDisk = await Promise.race([next.forSend(id, afterRestart), new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 300))])
        assert.ok(lentFromDisk !== "waited", "after a restart a Fin's worktree is lent the fields kept on disk")
        assert.equal(lentFromDisk.configuredModel, "project-model")
        restartGate.resolve()
        folderHold = null
        await until(() => folderLoads === 7)
      } finally {
        folderHold = null
        await next.stop()
      }

      // A loader that can parse the folder's configuration answers the send by itself: no discovery at all.
      assert.ok(folderLoader.folder)
      folderLoader.folder.read = async (_env, cwd) => fieldsOf(cwd)
      const parsedFolder = worktree("wt-parsed", "parsed-model")
      const parsed = await profiles.forSend(id, parsedFolder)
      assert.equal(parsed.configuredModel, "parsed-model", "a send in a new worktree launches on the model its project file names")
      assert.deepEqual(parsed.models, models)
      assert.deepEqual(await profiles.resolveLaunch(id, parsedFolder, parsed.settings), { model: "parsed-model" })
      const finStart = await profiles.forSend(id, worktree("wt-fin", "other-model"))
      assert.equal(finStart.settings?.model, "other-model", "and a Fin's start reads the same")
      await quiet()
      assert.equal(folderLoads, 7, "with zero discoveries where the loader can parse it")
    } finally {
      folderHold = null
      unlisten()
      unregister()
    }
  }
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
      provider: id, label: family, transport: "sdk", defaults: { work: [] },
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
    const unlisten = profiles.onProfile(event => { if (event.profile.id === id) published.push(event.profile.models[0]?.id ?? "none") })
    try {
      const oldRequest = profiles.get(id, true, workspace("one"))
      const obsoleteRejected = assert.rejects(oldRequest, /superseded/)
      await until(() => calls === 1)
      const refresh = profiles.refresh(id)
      await until(() => calls === 2)
      assert.equal(displaySignals[0]!.aborted, true, `${family}: refresh cancels the obsolete display owner`)
      assert.equal(displaySignals[1]!.aborted, false, `${family}: refresh cannot cancel its replacement`)
      oldGate.resolve(obsolete)
      await obsoleteRejected
      // A normal consumer joins the replacement or reads its completed cache.
      // A second forced refresh is allowed to start another query if realpath
      // finishes after the first one, so it cannot prove single publication.
      const joined = profiles.get(id, false, workspace("one"))
      await settle()
      assert.equal(calls, 2, `${family}: stale completion cannot delete the new request`)
      latestGate.resolve(newest)
      await refresh
      assert.equal((await joined).models[0]!.id, "new-runtime")
      assert.equal(calls, 2, `${family}: a consumer joins discovery or reads its completed cache`)
      assert.deepEqual(published, ["new-runtime"], `${family}: obsolete results cannot publish`)
      published.length = 0
      assert.equal((await profiles.forSend(id, workspace("one"))).models[0]!.id, "new-runtime")
      accountScope = "send"
      const oldSend = profiles.forSend(id, workspace("one"))
      const oldSendRejected = assert.rejects(oldSend, /superseded/)
      await until(() => sendCalls === 1)
      await profiles.refresh(id)
      assert.equal(sendSignals[0]!.aborted, true, `${family}: refresh cancels obsolete send discovery`)
      // Past the moment a harness that said it lists nothing is taken at its word.
      now += ASKED_AGAIN_MS + 1
      const newSend = profiles.forSend(id, workspace("one"))
      await until(() => sendCalls === 2)
      assert.equal(sendSignals[1]!.aborted, false, `${family}: a new send receives a live owner`)
      oldSendGate.resolve(obsolete)
      await oldSendRejected
      const joinedSend = profiles.forSend(id, workspace("one"))
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
    "Send discovery: a window's start, the heartbeat, a send and a Fin's start read what is held (memory, disk, the account's list) and discover nothing; the picker asks once; nothing crosses accounts; a runtime change is one discovery; failures back off; a send in a new folder launches on what the folder configures (parsed, lent by a worktree with the same project file, or discovered); option validation, concurrent launches, aliases and the revision fence are preserved"
  )
} finally {
  await rm(workspaceRoot, { recursive: true, force: true })
  stopReporting()
  only.mock.restore()
  clock.mock.restore()
}
