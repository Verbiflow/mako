import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import os from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { assertAccountLaunch, resolveAccountLaunch, selectAccount, type AccountLaunch } from "../electron/accounts.ts"
import { providerHost } from "../electron/providers/index.ts"
import { createProviderHost } from "../electron/providers/host.ts"
import { withExecutionAdmission } from "../electron/providers/execution-admission.ts"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.ts"
import type { PromptDispatch } from "../electron/providers/prompt-dispatch.ts"
import type { LiveSessionState } from "../electron/shared.ts"
import { claudeSdkOptions } from "../electron/providers/claude/sdk-options.ts"
import { traceProviderLaunch } from "../electron/provider-launch.ts"
import { LiveConversations } from "../electron/live-conversations.ts"
import { LiveJournal } from "../electron/live-journal.ts"
import { setTimeout as delay } from "node:timers/promises"

const root = await mkdtemp(join(os.tmpdir(), "mako-execution-admission-"))
mock.method(os, "homedir", () => root)
syncBuiltinESMExports()
const launch = (name: string): AccountLaunch => ({ env: { FIXTURE_IDENTITY: name }, account: { name, dir: join(root, name) }, selection: { kind: "selectable", name } })
const state = (provider: string, id: string): LiveSessionState => ({ harness: provider, id, cwd: root, nativeId: "fixture-native", connection: "connected", status: "ready", modes: [], currentMode: null, configOptions: [] })
const evidence: string[] = []
const identityChecks = { principal: async () => undefined, mismatch: async (principal: string, expected: string) => new Error(`signed in as ${principal}, not ${expected}`) }
const dispatch = (): PromptDispatch => ({ operationId: randomUUID(), attemptId: randomUUID(), report: value => evidence.push(value.kind) })
try {
  // Real registry/account facade and actual private selection files, in an
  // isolated home. No native service or real account is changed.
  const provider = "future-admission-fixture"
  let revision = "private-fixture-revision"
  let rotateDuringPreparation = false
  const removeAccount = providerHost.accountCapabilities.register({
    provider, mode: "selectable", label: provider, loginCommand: "fixture", listAccounts: async () => [],
    accountEnv: async (name, base) => {
      if (rotateDuringPreparation) revision = "private-fixture-rotated-during-preparation"
      return { ...base, FIXTURE_IDENTITY: name ?? "default" }
    },
    selectedAccount: name => ({ name: name ?? "default", dir: join(root, name ?? "default") }),
    credentialRevision: async () => revision, accountUsage: async () => ({ status: "unavailable" }),
    captureAccount: async () => {}, removeAccount: async () => ({}),
  })
  const prototype = providerHost.liveDrivers.list()[0]!
  const identities: string[] = []
  let running = false
  let approvals = 0
  let stops = 0
  let closes = 0
  const host = createProviderHost()
  host.liveDrivers.register({
    ...prototype, provider,
    start: async (_cwd, options) => {
      assert.ok(options.accountLaunch, "registry prepares the launch before reaching the adapter")
      identities.push(options.accountLaunch.env.FIXTURE_IDENTITY!)
      assert.equal(options.accountLaunch.account.name, options.accountLaunch.env.FIXTURE_IDENTITY)
      // Native transport configuration cannot mutate the retained snapshot.
      options.accountLaunch.env.FIXTURE_IDENTITY = "transport-local-change"
      options.accountLaunch.account.name = "transport-local-account"
      if (options.accountLaunch.selection.kind === "selectable") options.accountLaunch.selection.name = "transport-local-selection"
      if (options.accountLaunch.credential) options.accountLaunch.credential.revision = "transport-local-revision"
      running = true
      return state(provider, options.conversationId)
    },
    prompt: async () => { assert.equal(running, true); identities.push("prompt") },
    permission: async () => { approvals++ }, cancel: async () => { stops++ }, close: async () => { closes++; running = false },
  })
  const guarded = host.liveDrivers.get(provider)!
  await selectAccount(provider, "one")
  const first = await resolveAccountLaunch(provider, {})
  await guarded.start(root, { conversationId: "binding" })
  await guarded.prompt("binding", "first", [], undefined, dispatch())
  await selectAccount(provider, "two")
  await assert.rejects(assertAccountLaunch(provider, first), /selected account changed/)
  await assert.rejects(guarded.prompt("binding", "must not spend", [], undefined, dispatch()), /selected account changed/)
  assert.deepEqual(identities, ["one", "prompt"], "a warm process cannot spend after the selection changes")
  assert.equal(evidence.at(-1), "not-accepted", "this is definite preflight refusal, not uncertain native delivery")
  assert.equal(running, true, "switching accounts never cancels admitted work")
  await guarded.permission("binding", "existing", { kind: "choice", optionId: "allow" }, { assertCurrent: () => {}, report: () => {} })
  await guarded.cancel("binding")
  assert.equal(approvals, 1)
  assert.equal(stops, 1)
  await Promise.all([guarded.close("binding"), guarded.close("binding")])
  assert.equal(closes, 1, "completed startup closes once, shared by concurrent callers")
  await guarded.start(root, { conversationId: "binding" })
  assert.equal(identities.at(-1), "two", "an explicit reopen uses the new global account")
  await guarded.close("binding")
  await guarded.start(root, { conversationId: "rotation" })
  const beforeRotation = identities.length
  revision = "private-fixture-rotated"
  await assert.rejects(guarded.prompt("rotation", "same account, new credentials", [], undefined, dispatch()), /credentials changed/)
  assert.equal(identities.length, beforeRotation, "same-name rotation refuses a stale warm process before native input")
  assert.equal(evidence.at(-1), "not-accepted")
  await guarded.close("rotation")
  rotateDuringPreparation = true
  await assert.rejects(guarded.start(root, { conversationId: "preparation-rotation" }), /credentials changed/)
  assert.equal(identities.length, beforeRotation, "credentials changing during preparation cannot reach native startup")
  rotateDuringPreparation = false
  await selectAccount(provider, null)
  await assert.rejects(assertAccountLaunch(provider, await Promise.resolve(first)), /selected account changed/)
  const measured = performance.now()
  await guarded.start(root, { conversationId: "measured" })
  for (let input = 0; input < 500; input++) await guarded.prompt("measured", "input", [], undefined, dispatch())
  await guarded.close("measured")
  console.log(JSON.stringify({ scope: "Shared admission with real isolated selection files; simulated transport, not native streaming", inputs: 500, elapsedMs: Math.round((performance.now() - measured) * 100) / 100 }))

  const id = randomUUID()
  const journals = join(root, "journals")
  await selectAccount(provider, "one")
  const owner = new LiveConversations({ root: journals, appPath: root, driver: () => guarded, history: async () => null, emit: () => {} })
  try {
    await owner.start(provider, root, { conversationId: id })
    const readyDeadline = performance.now() + 5_000
    while (owner.snapshot(id)?.session.status !== "ready") {
      assert.ok(performance.now() < readyDeadline, "Production owner did not finish native startup")
      await delay(5)
    }
    await selectAccount(provider, "two")
    const request = randomUUID()
    const sentBefore = identities.length
    owner.submit(id, request, "preserve this unsent prompt")
    const deadline = performance.now() + 5_000
    while (owner.snapshot(id)?.requests[0]?.status !== "failed") {
      assert.ok(performance.now() < deadline, JSON.stringify({ message: "Production dispatch did not record its refusal", session: owner.snapshot(id)?.session.status, requests: owner.snapshot(id)?.requests.map(item => ({ status: item.status, delivery: item.nativeDelivery?.evidence.kind, error: item.error })) }))
      await delay(5)
    }
    const saved = new LiveJournal(journals, id)
    try {
      const receipt = saved.read()?.requests[0]
      assert.equal(receipt?.nativeDelivery?.evidence.kind, "not-accepted")
      assert.equal(receipt?.text, "preserve this unsent prompt")
      assert.ok(!JSON.stringify(saved.read()).includes("FIXTURE_IDENTITY"), "private launch environment never reaches the journal")
    } finally { saved.close() }
    owner.submit(id, request, "preserve this unsent prompt")
    await delay(5)
    assert.equal(identities.length, sentBefore, "same operation receipt cannot replay a refused prompt")
    await owner.close(id)
  } finally { await owner.stop() }
  removeAccount()

  // Every current descriptor and a future descriptor run identical startup
  // and owner-fencing cases. These are transport simulations, not native passes.
  for (const original of [...providerHost.liveDrivers.list(), { ...prototype, provider: "future-fixture" }]) {
    assert.equal(original.launchEnvironment.kind, "prepared")
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let selected = "one"
    let prompts = 0
    let closed = false
    const driver: ProviderLiveDriver = {
      ...original,
      start: async (_cwd, options) => { started.resolve(); await release.promise; closed = false; return state(original.provider, options.conversationId) },
      close: async () => { closed = true }, prompt: async () => { prompts++ },
    }
    const account = {
      ...identityChecks,
      resolve: async () => launch(selected),
      assertCurrent: async (_provider: string, previous: AccountLaunch) => { if (previous.account.name !== selected) throw new Error("selected account changed") },
    }
    const openingGuard = withExecutionAdmission(driver, account)
    const opening = openingGuard.start(root, { conversationId: "startup" })
    const rejected = assert.rejects(opening, /closing/)
    await started.promise
    const closing = openingGuard.close("startup")
    await assert.rejects(openingGuard.start(root, { conversationId: "startup" }), /execution owner/)
    release.resolve()
    await Promise.all([rejected, closing])
    assert.equal(closed, true, `${original.provider}: late startup is actually closed`)
    await assert.rejects(openingGuard.prompt("startup", "cancelled", [], undefined, dispatch()), /owner is unavailable/)
    assert.equal(prompts, 0)
    const changing = Promise.withResolvers<void>()
    const began = Promise.withResolvers<void>()
    const changingGuard = withExecutionAdmission({ ...driver, start: async (_cwd, options) => { began.resolve(); await changing.promise; return state(original.provider, options.conversationId) } }, account)
    const changingStart = changingGuard.start(root, { conversationId: "changed" })
    const changingRejected = assert.rejects(changingStart, /account changed/)
    await began.promise
    selected = "two"
    changing.resolve()
    await changingRejected
    assert.equal(closed, true)
  }

  // A close wins while the asynchronous selection check is pending. A late
  // verifier cannot authorize input on a retired owner or its replacement.
  let check = Promise.resolve()
  let sent = 0
  let cleanupFails = false
  const race = withExecutionAdmission({ ...prototype, provider: "race-fixture",
    start: async (_cwd, options) => state("race-fixture", options.conversationId),
    prompt: async () => { sent++ }, close: async () => { if (cleanupFails) throw new Error("child cleanup unavailable") },
  }, { ...identityChecks, resolve: async () => launch("one"), assertCurrent: async () => check })
  await race.start(root, { conversationId: "race" })
  const pending = Promise.withResolvers<void>()
  check = pending.promise
  const input = race.prompt("race", "late", [], undefined, dispatch())
  const refused = assert.rejects(input, /closing|owner changed/)
  await race.close("race")
  pending.resolve()
  await refused
  assert.equal(sent, 0)
  check = Promise.resolve()
  await race.start(root, { conversationId: "race" })
  cleanupFails = true
  await assert.rejects(async () => race.close("race"), /cleanup unavailable/)
  await assert.rejects(race.start(root, { conversationId: "race" }), /execution owner/)
  await assert.rejects(race.prompt("race", "unsafe retry", [], undefined, dispatch()), /closing/)
  cleanupFails = false
  await race.close("race")

  // An early cancellation failure must still drain and close a late startup.
  // Keep the binding reserved until an explicit successful cleanup retry.
  const lateStart = Promise.withResolvers<void>()
  const lateStarted = Promise.withResolvers<void>()
  let lateAlive = false
  let lateCloses = 0
  const late = withExecutionAdmission({ ...prototype, provider: "late-cleanup-fixture",
    start: async (_cwd, options) => { lateStarted.resolve(); await lateStart.promise; lateAlive = true; return state("late-cleanup-fixture", options.conversationId) },
    close: async () => { if (++lateCloses === 1) throw new Error("early cancellation failed"); lateAlive = false },
  }, { ...identityChecks, resolve: async () => launch("one"), assertCurrent: async () => {} })
  const lateOpening = late.start(root, { conversationId: "late" })
  const lateRejected = assert.rejects(lateOpening, /closing/)
  await lateStarted.promise
  const lateClosing = Promise.resolve(late.close("late"))
  const cleanupRejected = assert.rejects(lateClosing, /early cancellation failed/)
  await delay(5)
  assert.equal(lateCloses, 1)
  await assert.rejects(late.start(root, { conversationId: "late" }), /execution owner/)
  lateStart.resolve()
  await Promise.all([lateRejected, cleanupRejected])
  assert.equal(lateAlive, false, "early cancellation errors cannot leave a late process alive")
  assert.equal(lateCloses, 2)
  await assert.rejects(late.start(root, { conversationId: "late" }), /execution owner/)
  await late.close("late")

  // A failed native handshake can leave a process alive. Failed cleanup must
  // retain the startup owner, just like failure while closing a ready process.
  let orphanAlive = false
  let orphanCleanupFails = true
  let orphanStarts = 0
  const orphan = withExecutionAdmission({ ...prototype, provider: "failed-handshake-fixture",
    start: async () => { orphanStarts++; orphanAlive = true; throw new Error("native handshake failed") },
    close: async () => { if (orphanCleanupFails) throw new Error("startup child still alive"); orphanAlive = false },
  }, { ...identityChecks, resolve: async () => launch("one"), assertCurrent: async () => {} })
  await assert.rejects(orphan.start(root, { conversationId: "orphan" }), /process could not close/)
  await assert.rejects(orphan.start(root, { conversationId: "orphan" }), /execution owner/)
  assert.equal(orphanStarts, 1)
  assert.equal(orphanAlive, true)
  orphanCleanupFails = false
  await orphan.close("orphan")
  assert.equal(orphanAlive, false)

  // The launch account stays held exactly while its owner exists: through a
  // ready session, released on close or a failed open, and kept while a
  // failed cleanup may have left a process running.
  const releases = new Map<string, number>()
  const resolved: string[] = []
  const holding = { ...identityChecks, assertCurrent: async () => {}, resolve: async (_provider: string, binding: string): Promise<AccountLaunch> => {
    resolved.push(binding)
    return { ...launch("one"), hold: { provider: "hold-fixture", name: "one", release: () => releases.set(binding, (releases.get(binding) ?? 0) + 1) } }
  } }
  let holdCleanupFails = false
  const held = withExecutionAdmission({ ...prototype, provider: "hold-fixture",
    start: async (_cwd, options) => {
      assert.equal(options.accountLaunch?.hold, undefined, "the adapter never receives the hold it could release")
      if (options.conversationId.startsWith("refused")) throw new Error("native handshake failed")
      return state("hold-fixture", options.conversationId)
    },
    close: async () => { if (holdCleanupFails) throw new Error("child still alive") },
  }, holding)
  await held.start(root, { conversationId: "ready" })
  assert.deepEqual(resolved, ["ready"], "the hold names the binding that owns the process")
  assert.equal(releases.get("ready"), undefined, "a ready session keeps its account")
  await held.close("ready")
  assert.equal(releases.get("ready"), 1)
  await assert.rejects(held.start(root, { conversationId: "refused-open" }), /handshake failed/)
  await delay(0)
  assert.equal(releases.get("refused-open"), 1, "a failed open lets go once its cleanup succeeded")
  holdCleanupFails = true
  await assert.rejects(held.start(root, { conversationId: "refused-orphan" }), /process could not close/)
  await delay(0)
  assert.equal(releases.get("refused-orphan"), undefined, "a process cleanup could not close keeps the account")
  holdCleanupFails = false
  await held.close("refused-orphan")
  assert.equal(releases.get("refused-orphan"), 1)
  const refusedEnvironment = withExecutionAdmission({ ...prototype, provider: "hold-unavailable-fixture",
    launchEnvironment: { kind: "unavailable", reason: "Fixture cannot apply managed credentials" },
    start: async (_cwd, options) => state("hold-unavailable-fixture", options.conversationId),
  }, holding)
  await assert.rejects(refusedEnvironment.start(root, { conversationId: "unapplied" }), /cannot apply/)
  await delay(0)
  assert.equal(releases.get("unapplied"), 1, "a launch refused after resolving still lets go")

  let observedRevision = "observed-one"
  const removeObserved = providerHost.accountCapabilities.register({
    provider: "observed-admission-fixture", mode: "observed", label: "fixture", loginCommand: "fixture",
    listAccounts: async () => [], accountEnv: async (_selection, base) => ({ ...base }),
    selectedAccount: () => ({ name: "default" }), credentialRevision: async () => observedRevision,
    accountUsage: async () => ({ status: "unavailable" }),
  })
  try {
    const observed = await resolveAccountLaunch("observed-admission-fixture", {})
    assert.equal(observed.selection.kind, "observed")
    await assertAccountLaunch("observed-admission-fixture", observed)
    observedRevision = "observed-two"
    await assert.rejects(assertAccountLaunch("observed-admission-fixture", observed), /credentials changed/,
      "externally owned/default credentials are guarded without a managed account selection")
  } finally { removeObserved() }

  let unavailableStarts = 0
  const unavailable = withExecutionAdmission({ ...prototype, provider: "unavailable-environment-fixture",
    launchEnvironment: { kind: "unavailable", reason: "Fixture cannot apply managed credentials" },
    start: async (_cwd, options) => { unavailableStarts++; return state("unavailable-environment-fixture", options.conversationId) },
  }, { ...identityChecks, resolve: async () => launch("one"), assertCurrent: async () => {} })
  await assert.rejects(unavailable.start(root, { conversationId: "managed" }), /cannot apply the selected account/)
  assert.equal(unavailableStarts, 0, "future adapters must refuse unsupported managed-account launches before starting")

  // The identity the native process reports is compared with the launch
  // account's email. A different principal refuses input before it reaches
  // the driver; a missing email or identity stays unverified, never matched.
  for (const [reported, listed, verdict] of [
    ["Other@Example.com", "me@example.com", "differs"],
    ["ME@example.com", "me@example.com", "matches"],
    ["me@example.com", undefined, "unavailable"],
  ] as const) {
    let delivered = 0
    const sessions: LiveSessionState[] = []
    const checked = withExecutionAdmission({ ...prototype, provider: "identity-fixture",
      start: async (_cwd, options) => {
        const session: LiveSessionState = { ...state("identity-fixture", options.conversationId), executionContext: {
          transport: "fixture", runtime: { kind: "unavailable", reason: "fixture" }, account: { kind: "configured", name: "one", managed: true },
          identity: { kind: "pending" }, store: { kind: "unavailable", reason: "fixture" },
        } }
        setTimeout(() => options.emit?.({ type: "live-session", session: { ...session, executionContext: { ...session.executionContext!,
          identity: { kind: "reported", principal: reported, backend: "fixture", via: "fixture initialization" } } } }), 5)
        return session
      },
      prompt: async () => { delivered++ }, close: async () => {},
    }, { ...identityChecks, principal: async () => listed, resolve: async () => launch("one"), assertCurrent: async () => {} })
    await checked.start(root, { conversationId: "identity", emit: event => { if (event.type === "live-session") sessions.push(event.session) } })
    await delay(20)
    assert.equal(sessions.at(-1)?.executionContext?.confirmation?.kind, verdict, `${verdict}: the session says whether it runs as its account`)
    const input = checked.prompt("identity", "who am I", [], undefined, dispatch())
    if (verdict === "differs") {
      await assert.rejects(input, /signed in as Other@Example\.com, not me@example\.com/)
      assert.equal(evidence.at(-1), "not-accepted")
      assert.equal(delivered, 0, "a mismatched identity never receives input")
    } else {
      await input
      assert.equal(delivered, 1)
    }
    await checked.close("identity")
  }

  // Exercise production Claude SDK configuration, not a copied environment
  // builder. It must retain the supplied account despite host defaults.
  const prepared = launch("isolated")
  const configured = await traceProviderLaunch("claude", "fixture-config", trace => claudeSdkOptions(root, {
    conversationId: randomUUID(), accountLaunch: prepared,
    mcpSnapshot: async () => ({ cwd: root, generatedAt: Date.now(), servers: [], providers: [] }),
  }, trace))
  assert.equal(configured.account.name, "isolated")
  assert.equal(configured.options.env?.FIXTURE_IDENTITY, "isolated")
  console.log("Execution admission: real selection files, warm refusal, preserved approvals/Stop, shared reopen, all-six/future startup cancellation, late-owner fences, failed cleanup retention and reported-identity confirmation (mismatch refused, unverified never matched) verified")
} finally {
  mock.restoreAll()
  syncBuiltinESMExports()
  await rm(root, { recursive: true, force: true })
}
