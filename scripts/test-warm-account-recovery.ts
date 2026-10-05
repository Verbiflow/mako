import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import os from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { ExecutionAccountChanged, selectAccount } from "../electron/accounts.ts"
import { providerHost } from "../electron/providers/index.ts"
import { createProviderHost } from "../electron/providers/host.ts"
import { LiveConversations } from "../electron/live-conversations.ts"
import type { LiveDriverEvent, LiveSessionState } from "../electron/shared.ts"
import { launchContext } from "../electron/execution-context.ts"

const root = await mkdtemp(join(os.tmpdir(), "mako-warm-account-"))
mock.method(os, "homedir", () => root)
syncBuiltinESMExports()
async function until(check: () => boolean) {
  const deadline = performance.now() + 5000
  while (!check()) { assert.ok(performance.now() < deadline, "Expected warm account transition"); await delay(5) }
}
try {
  const peers = providerHost.liveDrivers.list()
  for (const original of [...peers, { ...peers[0]!, provider: "future" }]) {
    const provider = `warm-fixture-${original.provider}`
    const nativePath = join(root, provider)
    await writeFile(nativePath, "fixture native source")
    let revision = "private-credential-one"
    let opens = 0
    let closes = 0
    let sends = 0
    let event: ((event: LiveDriverEvent) => void) | undefined
    let session: LiveSessionState
    let pending: (() => void) | undefined
    let hold = false
    let cleanupFails = false
    let closeGate: PromiseWithResolvers<void> | undefined
    let closeEntered = false
    let deliveryFailure: "accepted" | "uncertain" | undefined
    let expected: string | undefined
    const unregister = providerHost.accountCapabilities.register({
      provider, mode: "selectable", label: provider, loginCommand: "fixture",
      listAccounts: async () => expected ? [{ harness: provider, name: "mismatch", email: expected, dir: root, active: true }] : [], accountEnv: async (name, base) => ({ ...base, FIXTURE_ACCOUNT: name ?? "default" }),
      selectedAccount: name => ({ name: name ?? "default", dir: root }),
      credentialRevision: async () => revision, accountUsage: async () => ({ status: "unavailable" }),
      captureAccount: async () => {}, removeAccount: async () => {},
    })
    const host = createProviderHost()
    host.liveDrivers.register({ ...original, provider, canResume: true, available: () => true, nativeSource: undefined,
      start: async (_cwd, options) => {
        opens++
        event = options.emit
        const account = options.accountLaunch!.account
        const context = launchContext("fixture-transport", { kind: "reported", via: "simulated initialization" }, account)
        context.identity = { kind: "reported", principal: account.name, backend: "fixture", via: "simulated initialization" }
        context.runtime = { kind: "reported", version: "fixture-one", via: "fixture" }
        context.store = { kind: "located", path: nativePath }
        session = { id: options.conversationId, harness: provider, nativeId: "native-one", nativePath, cwd: root, status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [], executionContext: context }
        return session
      },
      prompt: async (_id, _text, _attachments, _settings, dispatch) => {
        sends++
        if (deliveryFailure) {
          dispatch.report(deliveryFailure === "accepted"
            ? { kind: "accepted", source: "native-response" }
            : { kind: "uncertain", reason: "simulated response loss" })
          throw new ExecutionAccountChanged("credentials")
        }
        event!({ type: "live-session", session: { ...session, status: "running" } })
        dispatch.report({ kind: "accepted", source: "native-response" })
        const finish = () => { event!({ type: "live-update", id: session.id, update: { kind: "text", text: "fixture answer" } }); event!({ type: "live-session", session }) }
        if (hold) pending = finish
        else finish()
      },
      close: async () => {
        if (cleanupFails) throw new Error("fixture child cleanup failed")
        closeEntered = true
        await closeGate?.promise
        closes++
      },
      cancel: async () => {}, permission: async () => {}, setMode: async () => {},
    })
    const driver = host.liveDrivers.get(provider)!
    const id = randomUUID()
    const owner = new LiveConversations({ root: join(root, provider + "-journals"), appPath: root, driver: () => driver,
      history: async () => null, emit: () => {}, providerIdleMs: 600_000, providerWarmLimit: 20,
      checkpoint: async () => "fixture-checkpoint", resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
    })
    const input = async (text: string) => { const requestId = randomUUID(); owner.submit(id, requestId, text); await until(() => owner.snapshot(id)?.requests.find(request => request.id === requestId)?.status === "completed"); return requestId }
    try {
      await selectAccount(provider, "one")
      await owner.start(provider, root, { conversationId: id })
      await until(() => owner.snapshot(id)?.session.status === "ready")
      await input("seed")
      await selectAccount(provider, "two")
      const second = await input("after selection")
      assert.equal(opens, 2, `${original.provider}: changed account reopens once`)
      assert.equal(closes, 1)
      assert.equal(sends, 2, "the refused attempt never reached native prompt")
      assert.equal(owner.snapshot(id)?.requests.filter(request => request.id === second).length, 1)
      assert.equal(owner.snapshot(id)?.blocks.filter(block => block.type === "user" && block.requestId === second).length, 1, "the unsent attempt shows its user block only once")
      assert.ok(!JSON.stringify(owner.snapshot(id)).includes("private-credential"), "private revisions never enter the journal or wire")
      revision = "private-credential-two"
      await input("same account rotated")
      assert.equal(opens, 3)
      assert.equal(sends, 3)

      // Global changes preserve a running turn. The next queued input reopens
      // only after that admitted turn completes.
      hold = true
      const running = randomUUID()
      owner.submit(id, running, "keep running")
      await until(() => owner.snapshot(id)?.session.status === "running")
      await selectAccount(provider, "three")
      const queued = randomUUID()
      owner.submit(id, queued, "wait behind work")
      await delay(5)
      assert.equal(closes, 2)
      hold = false
      pending!()
      await until(() => owner.snapshot(id)?.requests.find(request => request.id === queued)?.status === "completed")
      assert.equal(opens, 4)
      assert.equal(sends, 5)

      // Background work keeps the old process: the input waits unsent, says
      // what for, and switches by itself once that work ends.
      session = { ...session, backgroundTasks: 1 }
      event!({ type: "live-session", session })
      revision = "private-credential-three"
      const blocked = randomUUID()
      owner.submit(id, blocked, "do not kill children")
      await until(() => Boolean(owner.snapshot(id)?.requests.find(request => request.id === blocked)?.accountSwitch))
      const waiting = owner.snapshot(id)!.requests.find(request => request.id === blocked)!
      assert.equal(waiting.status, "queued")
      assert.deepEqual(waiting.accountSwitch, { reason: "credentials", waitingFor: "background" })
      assert.equal(waiting.nativeDelivery?.evidence.kind, "not-accepted")
      assert.equal(closes, 3)
      assert.equal(sends, 5)
      // A second input queues behind it rather than slipping out under the old account.
      const behind = randomUUID()
      owner.submit(id, behind, "queued behind the switch")
      await delay(20)
      assert.equal(sends, 5, "nothing sends under the old account while the switch waits")
      assert.equal(opens, 4)
      session = { ...session, backgroundTasks: undefined }
      event!({ type: "live-session", session })
      await until(() => owner.snapshot(id)?.requests.find(request => request.id === behind)?.status === "completed")
      assert.equal(owner.snapshot(id)?.requests.find(request => request.id === blocked)?.status, "completed")
      assert.equal(owner.snapshot(id)?.requests.find(request => request.id === blocked)?.accountSwitch, undefined)
      assert.equal(opens, 5, "the switch reopens once")
      assert.equal(closes, 4)
      assert.equal(sends, 7, "each waiting input sends once")
      assert.equal(owner.snapshot(id)?.blocks.filter(block => block.type === "user" && block.requestId === blocked).length, 1)

      // The error class alone never authorizes a retry after native submission.
      for (const evidence of ["accepted", "uncertain"] as const) {
        deliveryFailure = evidence
        const failed = randomUUID()
        const before = sends
        owner.submit(id, failed, "retain the native delivery receipt")
        await until(() => owner.snapshot(id)?.requests.find(request => request.id === failed)?.status === "failed")
        assert.equal(owner.snapshot(id)?.requests.find(request => request.id === failed)?.nativeDelivery?.evidence.kind, evidence)
        assert.equal(opens, 5)
        assert.equal(sends, before + 1, "accepted and unknown attempts cannot replay")
      }
      deliveryFailure = undefined
      event!({ type: "live-session", session })

      // Stop while cleanup is pending removes the unsent request. No eager
      // replacement is started when the user has cancelled the queued input.
      closeGate = Promise.withResolvers<void>()
      closeEntered = false
      revision = "private-credential-four"
      const cancelled = randomUUID()
      owner.submit(id, cancelled, "cancel during account retirement")
      await until(() => closeEntered)
      await owner.cancelRequest(id, cancelled)
      closeGate.resolve()
      await until(() => owner.snapshot(id)?.session.connection === "hibernated")
      assert.equal(owner.snapshot(id)?.requests.find(request => request.id === cancelled)?.status, "interrupted")
      assert.equal(opens, 5)
      assert.equal(sends, 9)
      closeGate = undefined
      await input("explicit input after cancellation")
      assert.equal(opens, 6)

      cleanupFails = true
      revision = "private-credential-five"
      const failedClose = randomUUID()
      owner.submit(id, failedClose, "retain a failed owner")
      await until(() => owner.snapshot(id)?.requests.find(request => request.id === failedClose)?.status === "failed")
      assert.equal(opens, 6, "failed child cleanup cannot create a replacement")
      assert.equal(sends, 10)
      cleanupFails = false

      // An agent signed in as someone else refuses input before sending. The
      // conversation stays usable and its process retires, so the next
      // message launches with whatever the user signs in or chooses.
      expected = "expected@example.com"
      await selectAccount(provider, "mismatch")
      const other = randomUUID()
      const sentBefore = sends
      await owner.start(provider, root, { conversationId: other })
      await until(() => owner.snapshot(other)?.session.executionContext?.confirmation !== undefined)
      assert.deepEqual(owner.snapshot(other)?.session.executionContext?.confirmation, { kind: "differs", principal: "mismatch", expected })
      const wrong = randomUUID()
      owner.submit(other, wrong, "never as the wrong person")
      await until(() => owner.snapshot(other)?.requests.find(request => request.id === wrong)?.status === "failed")
      const refusal = owner.snapshot(other)!.requests.find(request => request.id === wrong)!
      assert.equal(refusal.failure, "wrong-account")
      assert.equal(refusal.nativeDelivery?.evidence.kind, "not-accepted")
      assert.equal(sends, sentBefore, "nothing reaches the agent signed in as someone else")
      assert.notEqual(owner.snapshot(other)?.session.status, "failed", "the conversation is not failed by a refused input")
      await until(() => owner.snapshot(other)?.session.connection === "hibernated")
      expected = undefined
    } finally { cleanupFails = false; await owner.stop(); unregister() }
  }
  console.log("Warm accounts: six/future registry descriptors, selection and same-name rotation, one reopen/dispatch, stable prompt identity, running/queued preservation, background work waiting then switching by itself, cancellation during retirement, accepted/uncertain no-replay, cleanup retention and wrong-identity refusal (not sent, session kept, process retired) verified. Native transports simulated.")
} finally { mock.restoreAll(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }) }
