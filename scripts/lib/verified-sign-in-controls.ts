import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { mock } from "node:test"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { createProviderHost } from "@mako/host/harnesses/host"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { launchContext } from "@mako/host/base/execution-context"
import { signInPause } from "@mako/host/contracts/sign-in-hold"
import { strandedTurn } from "@mako/host/contracts/turn-continuation"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { VerifiedSignIn } from "@mako/host/harnesses"
import { LiveJournal, JournalWriteError } from "@mako/host/conversations/live-journal"
import { followHostLog, type HostLogLine } from "@mako/host/base/host-log"

async function until(check: () => boolean, label: string): Promise<void> {
  const end = performance.now() + 5_000
  while (!check()) { assert.ok(performance.now() < end, label); await delay(5) }
}

/** Real account verification, journal release and native dispatch; all credentials and transports are synthetic. */
export async function verifiedSignInControls(root: string): Promise<void> {
  const descriptors = createHarnessHost(detachedHarnessContext(new NativeStores(false)))
  const original = descriptors.liveDrivers.get("claude")
  assert.ok(original)
  for (const control of ["cohort", "restart-gap", "stop", "close", "archive", "unknown", "empty", "new-generation", "wrong-account", "verification-fails", "room", "store-fault", "principal-changed", "unverified", "legacy-receipt", "reopening", "bad-listener", "manual-stop", "manual-overlap", "baseline-overlap", "start-restart-gap"] as const) {
    const folder = join(root, `verified-${control}`)
    await mkdir(folder, { recursive: true })
    const nativePath = join(folder, "native")
    await writeFile(nativePath, "fixture native source")
    const provider = "verified-signin-fixture"
    const host = createProviderHost({ userRoot: join(folder, "user") })
    const accountOut = new Set(["one", "two"])
    let rejectVerification = false
    let verified = 0
    let changedPrincipal = false
    let allowed = true
    let room = true
    let notify: ((receipt: VerifiedSignIn) => void) | undefined
    let lastReceipt: VerifiedSignIn | undefined
    let reopening = false
    let releaseOpen: (() => void) | undefined
    let blockRead = control === "baseline-overlap"
    let reading = false
    let releaseRead: (() => void) | undefined
    const stopBadListener = control === "bad-listener" ? host.accounts.onSignedIn(() => { throw new Error("Fixture consumer failed after verified publication") }) : undefined
    const log: HostLogLine[] = []
    const stopLog = followHostLog(line => { if (control === "store-fault" && line.scope === "live") { log.push(line); if (log.length > 20) log.shift() } })
    let failRelease = control === "store-fault"
    let releaseFailed = false
    const commit = LiveJournal.prototype.commit
    const fault = control === "store-fault" ? mock.method(LiveJournal.prototype, "commit", function(this: LiveJournal, ...args: Parameters<typeof commit>) {
      if (failRelease && args[1]?.requests.some(request => request.signIn) && !args[0].requests.some(request => request.signIn)) {
        failRelease = false; releaseFailed = true
        throw new JournalWriteError(new Error("Fixture cannot commit the sign-in release"))
      }
      return commit.call(this, ...args)
    }) : undefined
    const sent: { id: string; text: string }[] = []
    const emitters = new Map<string, (event: LiveDriverEvent) => void>()
    const sessions = new Map<string, LiveSessionState>()
    const names = new Map<string, string>()
    const unregister = host.accountCapabilities.register({
      provider, mode: "selectable", label: "Fixture", loginCommand: "fixture", nativeLogin: true,
      listAccounts: async selection => ["one", "two"].map(name => ({ harness: provider, name, dir: folder, active: selection === name, source: "mako" as const, route: "managed" as const, email: changedPrincipal ? "another@example.test" : `${name}@example.test` })),
      accountEnv: async (name, base) => ({ ...base, HOME: folder, FIXTURE_ACCOUNT: name ?? "one" }),
      selectedAccount: name => ({ name: name ?? "one", dir: folder }),
      // A verified token renewal intentionally leaves execution identity unchanged.
      credentialRevision: async () => "same-principal",
      accountUsage: async () => ({ status: "unavailable" }),
      captureAccount: async () => {}, removeAccount: async () => ({}),
      prepareAccountLogin: async () => ({ kind: "task", run: async () => {} }),
      ...(control !== "unverified" && { confirmAccountLogin: async (target: { name: string }) => { if (rejectVerification) throw new Error("Fixture verification rejected"); verified++; changedPrincipal = control === "principal-changed"; accountOut.delete(target.name) } }),
      abandonAccountLogin: async () => {},
    })
    host.liveDrivers.register({ ...original, provider, available: () => true, nativeSource: undefined,
      start: async (_cwd, options) => {
        if ((control === "baseline-overlap" || control === "start-restart-gap") && accountOut.has("one")) throw new Error("Failed to authenticate: OAuth session expired and could not be refreshed")
        if (control === "reopening" && sent.length > 0) {
          reopening = true
          await new Promise<void>(resolve => { releaseOpen = resolve })
        }
        const account = options.accountLaunch.account
        const context = launchContext("fixture", { kind: "reported", via: "fixture" }, account)
        context.store = { kind: "located", path: nativePath }
        const session: LiveSessionState = { id: options.conversationId, harness: provider, nativeId: options.resume ?? `native-${options.conversationId}`, nativePath, cwd: folder, status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [], executionContext: context }
        sessions.set(session.id, session)
        names.set(session.id, account.name ?? "one")
        emitters.set(session.id, options.emit)
        return session
      },
      prompt: async (id, text, _attachments, _settings, dispatch) => {
        const emit = emitters.get(id)!
        const session = sessions.get(id)!
        sent.push({ id, text })
        if (control !== "unknown" || !accountOut.has(names.get(id)!)) {
          emit({ type: "live-session", session: { ...session, status: "running" } })
          dispatch.report({ kind: "accepted", source: "native-response" })
        }
        await delay(15)
        if (accountOut.has(names.get(id)!)) {
          if (control === "unknown") {
            dispatch.report({ kind: "uncertain", reason: "Fixture lost the acceptance response" })
            throw new Error("Failed to authenticate: OAuth session expired and could not be refreshed")
          }
          emit({ type: "live-session", session: { ...session, status: "failed", lastStop: "failed", error: "Failed to authenticate: OAuth session expired and could not be refreshed" } })
        } else {
          dispatch.report({ kind: "accepted", source: "native-response" })
          emit({ type: "live-update", id, update: { kind: "text", text: "Fixture completed" } })
          emit({ type: "live-session", session })
        }
      },
      close: async () => {}, cancel: async () => {}, permission: async () => {}, setMode: async () => {},
    })
    const dependencies = {
      root: join(folder, "journals"), appPath: folder, driver: () => host.liveDrivers.get(provider), history: async () => null, emit: () => {},
      providerIdleMs: 600_000, providerWarmLimit: 20, saveAgainMs: 100, checkpoint: async () => "checkpoint", resumeVerdict: async () => ({ kind: "resumable" as const, record: "same" as const }),
      signInState: async (h: string, a: string) => {
        const state = await host.accounts.signInState(h, a)
        if (blockRead) {
          reading = true
          await new Promise<void>(resolve => { releaseRead = resolve })
          if (control === "manual-stop") return { ...state, credential: "fixture-new-credential" }
        }
        return state
      }, signInProof: (h: string, a: string) => host.accounts.signInProof(h, a), signInSequence: (h: string) => host.accounts.signInSequence(h),
      signInEvents: (listener: (receipt: VerifiedSignIn) => void) => {
        notify = listener
        return host.accounts.onSignedIn(receipt => { lastReceipt = receipt; listener(receipt) })
      },
      signInAllowed: () => allowed,
      agents: () => ({ mayWake: () => room, roster: () => [], stopChild: async () => false, settled: () => {}, isApex: () => false, frontDoor: () => [], ruleLines: () => ({}) }),
    }
    let live = new LiveConversations(dependencies)
    const waits: { id: string; cut: string; queued: string[] }[] = []
    async function held(account = "one", existing?: string) {
      await host.accounts.select(provider, account)
      const id = existing ?? randomUUID()
      if (control === "baseline-overlap" || control === "start-restart-gap") {
        const cut = randomUUID()
        const queued = [cut, randomUUID(), randomUUID()]
        await live.start(provider, folder, { conversationId: id, initialRequest: { id: cut, text: `Held message ${cut} 0`, attachments: [] } })
        await until(() => control === "baseline-overlap" ? reading : Boolean(signInPause(live.snapshot(id)!.requests)?.hold.credential), "refused first launch's account lookup")
        for (const [index, request] of queued.slice(1).entries()) live.submit(id, request, `Held message ${cut} ${index + 1}`)
        if (control === "baseline-overlap") { await login(); blockRead = false; releaseRead!() }
        const item = { id, cut, queued }; waits.push(item); return item
      }
      if (!existing) await live.start(provider, folder, { conversationId: id })
      await until(() => live.session(id)?.status === "ready", "native session ready")
      const cut = randomUUID()
      live.submit(id, cut, "Work interrupted by auth")
      await until(() => control === "unknown" ? live.snapshot(id)?.requests.find(request => request.id === cut)?.status === "dispatching" : live.session(id)?.status === "running", `native turn started (${control})`).catch(error => {
        console.log(JSON.stringify({ control, session: live.session(id), requests: live.snapshot(id)?.requests }))
        throw error
      })
      const queued = control === "empty" ? [] : [randomUUID(), randomUUID()]
      for (const [index, request] of queued.entries()) live.submit(id, request, `Held message ${cut} ${index}`)
      await until(() => Boolean(signInPause(live.snapshot(id)!.requests)?.hold.credential), `hold baseline recorded (${control})`).catch(error => {
        console.log(JSON.stringify({ control, session: live.session(id), requests: live.snapshot(id)?.requests }))
        throw error
      })
      assert.equal(strandedTurn(live.snapshot(id)!.requests), undefined, "the account asks for sign-in; no per-Fin Continue/Stop question")
      const item = { id, cut, queued }; waits.push(item); return item
    }
    async function login(account = "one") { return host.accounts.finishLogin(provider, { name: account, renew: true }, { previousEmail: `${account}@example.test` }) }
    function completed() { return waits.every(item => item.queued.every(request => live.snapshot(item.id)?.requests.find(row => row.id === request)?.status === "completed")) }
    try {
      await held()
      if (control === "cohort" || control === "manual-overlap") await held()
      if (control === "wrong-account") await held("two")
      if (control === "stop") for (const { id } of waits) live.stopHolds(id)
      if (control === "close") for (const { id } of waits) await live.close(id)
      if (control === "archive") { allowed = false; for (const { id } of waits) live.setArchived(id, true) }
      if (control === "room") room = false
      if (control === "verification-fails") {
        rejectVerification = true
        await assert.rejects(login(), /Fixture verification rejected/)
        assert.equal(host.accounts.signInProof(provider, "one"), undefined)
        assert.equal(lastReceipt, undefined)
        assert.equal(verified, 0)
        assert.equal(completed(), false)
        continue
      }
      let manual: Promise<unknown> | undefined
      if (control === "manual-stop" || control === "manual-overlap") {
        blockRead = true
        manual = live.resumeSignIn(waits[0]!.id)
        await until(() => reading, "manual readiness read is in flight")
        if (control === "manual-stop") {
          live.stopHolds(waits[0]!.id)
          blockRead = false; releaseRead!()
          assert.equal(await manual, "signed-out", "an earlier Resume cannot undo a later Stop")
          assert.equal(sent.length, 1)
          continue
        }
      }
      if (control === "restart-gap" || control === "legacy-receipt" || control === "start-restart-gap") await live.stop()
      if (control === "legacy-receipt") {
        const journal = new LiveJournal(dependencies.root, waits[0]!.id)
        try {
          const saved = journal.read()!
          journal.commit({ ...saved, requests: saved.requests.map(request => {
            if (!request.signIn) return request
            const { id: _id, verification: _verification, ...legacy } = request.signIn
            return { ...request, signIn: legacy }
          }) }, saved)
        } finally { journal.close() }
      }
      if (control !== "baseline-overlap") await login()
      if (control === "manual-overlap") {
        await until(() => waits[1]!.queued.every(request => live.snapshot(waits[1]!.id)!.requests.find(row => row.id === request)?.status === "completed"), "one manual readiness read cannot strand its account siblings")
        blockRead = false; releaseRead!(); await manual
      }
      if (control === "reopening") {
        await until(() => reopening, "fresh native session is reopening")
        const item = waits[0]!
        const request = randomUUID()
        item.queued.push(request)
        live.submit(item.id, request, `Held message ${item.cut} 2`)
        assert.equal(live.snapshot(item.id)!.requests.find(row => row.id === request)?.status, "queued", "input during reopen remains durable unsent work")
        releaseOpen!()
      }
      if (control === "principal-changed" || control === "unverified") {
        assert.equal(host.accounts.signInProof(provider, "one"), undefined, "a different principal or unverified listing grants no automatic release")
        await delay(30)
        assert.equal(sent.length, 1)
        assert.ok(signInPause(live.snapshot(waits[0]!.id)!.requests))
        continue
      }
      if (control === "store-fault") {
        await until(() => releaseFailed, "release commit failed")
        assert.ok(signInPause(live.snapshot(waits[0]!.id)!.requests), "a failed commit keeps the hold in memory and on disk")
        assert.equal(sent.length, 1, "nothing dispatched before the release is durable")
      }
      if (control === "restart-gap" || control === "start-restart-gap") live = new LiveConversations(dependencies)
      if (control === "legacy-receipt") {
        live = new LiveConversations(dependencies)
        await delay(30)
        assert.equal(sent.length, 1, "a cursorless legacy hold cannot infer freshness from an already-kept receipt")
        await login()
      }
      if (control === "stop" || control === "close" || control === "archive") {
        await delay(30)
        assert.equal(sent.length, 1, "automatic sign-in recovery cannot override Stop/Close/archive")
        await live.stop(); live = new LiveConversations(dependencies)
        await delay(30)
        assert.equal(sent.length, 1, "the refusal survives restart")
        continue
      }
      if (control === "room") {
        await delay(30)
        assert.equal(sent.length, 1, "no execution place yet")
        assert.ok(signInPause(live.snapshot(waits[0]!.id)!.requests))
        room = true; live.wakeDue()
      }
      if (control === "wrong-account") {
        await until(() => waits[0]!.queued.every(request => live.snapshot(waits[0]!.id)!.requests.find(row => row.id === request)?.status === "completed"), "matching account resumed")
        assert.ok(signInPause(live.snapshot(waits[1]!.id)!.requests), "another account stays held")
        await login("two")
      }
      if (control === "empty") await until(() => live.snapshot(waits[0]!.id)!.requests.some(row => row.continues?.requestId === waits[0]!.cut && row.status === "completed"), "accepted cut resumes with no queued message")
      else await until(completed, `all matching sessions and messages resumed (${control})`).catch(error => {
        console.log(JSON.stringify({ control, log, sessions: waits.map(item => ({ session: live.session(item.id), requests: live.snapshot(item.id)?.requests })) }))
        throw error
      })
      if (control === "new-generation") {
        const stale = lastReceipt!
        accountOut.add("one")
        const item = await held("one", waits[0]!.id)
        const generation = signInPause(live.snapshot(item.id)!.requests)!.hold.id
        notify!(stale); notify!(stale)
        await delay(30)
        assert.equal(signInPause(live.snapshot(item.id)!.requests)?.hold.id, generation, "old receipt cannot release a newer sign-out")
        await login(); await until(completed, "fresh receipt recovers new generation")
      }
      const count = sent.length
      if (lastReceipt) { notify!(lastReceipt); notify!(lastReceipt) }
      await delay(30)
      assert.equal(sent.length, count, "duplicate receipt sends nothing twice")
      for (const item of waits) {
        assert.equal(signInPause(live.snapshot(item.id)!.requests), undefined)
        for (const [index, request] of item.queued.entries()) {
          assert.equal(live.snapshot(item.id)!.requests.find(row => row.id === request)?.status, "completed")
          assert.equal(sent.filter(row => row.id === item.id && row.text === `Held message ${item.cut} ${index}`).length, 1)
        }
        const continuations = live.snapshot(item.id)!.requests.filter(row => row.continues?.requestId === item.cut)
        assert.equal(continuations.length, control === "unknown" || control === "baseline-overlap" || control === "start-restart-gap" ? 0 : 1, "unknown acceptance is never replayed; an unsent first request is sent once")
      }
    } finally { releaseRead?.(); releaseOpen?.(); await live.stop(); fault?.mock.restore(); stopLog(); stopBadListener?.(); unregister() }
  }
  console.log("PASS: one verified same-principal login recovers every matching held session once; reset/receipt generations, restart gap, unknown delivery, account, Stop/Close/archive and execution room are fenced")
}
