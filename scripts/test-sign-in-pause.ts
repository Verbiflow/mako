import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import os from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { selectAccount } from "../electron/accounts.ts"
import { providerHost } from "../electron/providers/index.ts"
import { createProviderHost } from "../electron/providers/host.ts"
import { LiveConversations } from "../electron/live-conversations.ts"
import { signInPause } from "../electron/contracts/sign-in-hold.ts"
import type { LiveDriverEvent, LiveRequest, LiveSessionState } from "../electron/shared.ts"
import { launchContext } from "../electron/execution-context.ts"

/**
 * An account that signs out in the middle of a turn, for every registered
 * harness descriptor and a future one: the work pauses with the session,
 * nothing sends until the user resumes after signing in, Resume admits one
 * continuation however often it is pressed, a sign-out again before or
 * during Resume pauses again, an unknown outcome is never sent again, and
 * the pause survives a restart. Native transports are simulated.
 */
const root = await mkdtemp(join(os.tmpdir(), "mako-sign-in-pause-"))
mock.method(os, "homedir", () => root)
syncBuiltinESMExports()
async function until(check: () => boolean, what: string) {
  const deadline = performance.now() + 5000
  while (!check()) { assert.ok(performance.now() < deadline, `Expected ${what}`); await delay(5) }
}
const SIGNED_OUT = "Failed to authenticate: OAuth session expired and could not be refreshed"
type Mode = "ok" | "accepted-sign-out" | "refused-sign-out" | "uncertain-sign-out" | "plan"

try {
  const peers = providerHost.liveDrivers.list()
  assert.ok(peers.length >= 6, "every harness registers a live driver")
  for (const original of [...peers, { ...peers[0]!, provider: "future" }]) {
    const provider = `signin-fixture-${original.provider}`
    const label = original.provider
    const nativePath = join(root, provider)
    await writeFile(nativePath, "fixture native source")
    let revision = "private-credential-one"
    let opens = 0
    let sends = 0
    let mode: Mode = "ok"
    let refuseStart = false
    const emitters = new Map<string, (event: LiveDriverEvent) => void>()
    const sessions = new Map<string, LiveSessionState>()
    const sent: string[] = []
    const unregister = providerHost.accountCapabilities.register({
      provider, mode: "selectable", label: provider, loginCommand: "fixture",
      listAccounts: async () => [], accountEnv: async (name, base) => ({ ...base, FIXTURE_ACCOUNT: name ?? "default" }),
      selectedAccount: name => ({ name: name ?? "default", dir: root }),
      credentialRevision: async () => revision, accountUsage: async () => ({ status: "unavailable" }),
      captureAccount: async () => {}, removeAccount: async () => ({}),
    })
    const host = createProviderHost()
    host.liveDrivers.register({ ...original, provider, available: () => true, nativeSource: undefined,
      start: async (_cwd, options) => {
        opens++
        if (refuseStart) throw new Error(`The selected ${label} account is signed out. Sign in again in Settings → Agents.`)
        const account = options.accountLaunch!.account
        const context = launchContext("fixture-transport", { kind: "reported", via: "simulated initialization" }, account)
        context.store = { kind: "located", path: nativePath }
        const session: LiveSessionState = { id: options.conversationId, harness: provider, nativeId: options.resume ?? `native-${options.conversationId}`, nativePath, cwd: root, status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [], executionContext: context }
        if (options.emit) emitters.set(session.id, options.emit)
        sessions.set(session.id, session)
        return session
      },
      prompt: async (id, text, _attachments, _settings, dispatch) => {
        const event = emitters.get(id)!
        const session = sessions.get(id)!
        sends++
        sent.push(text)
        if (mode === "refused-sign-out") {
          dispatch.report({ kind: "not-accepted", source: "preflight", reason: "simulated refusal" })
          throw new Error("401 Unauthorized: Not logged in · Please run /login")
        }
        if (mode === "uncertain-sign-out") {
          dispatch.report({ kind: "uncertain", reason: "simulated response loss" })
          throw new Error(SIGNED_OUT)
        }
        event({ type: "live-session", session: { ...session, status: "running" } })
        dispatch.report({ kind: "accepted", source: "native-response" })
        event({ type: "live-update", id: session.id, update: { kind: "text", text: "fixture answer" } })
        if (mode === "accepted-sign-out" || mode === "plan") {
          // Messages typed while the turn runs queue behind it.
          await delay(15)
          event({ type: "live-session", session: { ...session, status: "failed", lastStop: "failed",
            error: mode === "plan" ? "Your credit balance is too low to access the Anthropic API." : SIGNED_OUT } })
          return
        }
        event({ type: "live-session", session })
      },
      close: async () => {}, cancel: async () => {}, permission: async () => {}, setMode: async () => {},
    })
    const driver = host.liveDrivers.get(provider)!
    const journals = join(root, provider + "-journals")
    const owner = (): LiveConversations => new LiveConversations({ root: journals, appPath: root, driver: () => driver,
      history: async () => null, emit: () => {}, providerIdleMs: 600_000, providerWarmLimit: 20, autoContinueDelayMs: 10,
      checkpoint: async () => "fixture-checkpoint", resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
    })
    let live = owner()
    const id = randomUUID()
    const request = (requestId: string, conversation = id): LiveRequest | undefined =>
      live.snapshot(conversation)?.requests.find((item) => item.id === requestId)
    const userBlocks = (requestId: string, conversation = id) =>
      live.snapshot(conversation)?.blocks.filter((block) => block.type === "user" && block.requestId === requestId).length
    try {
      await selectAccount(provider, "one")
      await live.start(provider, root, { conversationId: id })
      await until(() => live.snapshot(id)?.session.status === "ready", `${label}: ready`)
      const seed = randomUUID()
      live.submit(id, seed, "seed")
      await until(() => request(seed)?.status === "completed", `${label}: seed completes`)

      // The account signs out mid-turn, after the provider accepted the prompt.
      mode = "accepted-sign-out"
      const cut = randomUUID()
      live.submit(id, cut, "long work")
      await until(() => live.snapshot(id)?.session.status === "running", `${label}: turn runs`)
      const behind = randomUUID()
      live.submit(id, behind, "typed while it ran")
      await until(() => request(cut)?.status === "interrupted", `${label}: the turn is cut short`)
      assert.equal(request(cut)?.interruption?.reason, "signed-out", `${label}: cut short by the sign-out`)
      assert.equal(request(cut)?.failure, "auth")
      assert.equal(request(behind)?.status, "held", `${label}: the queued message waits`)
      await until(() => Boolean(request(behind)?.signIn?.credential), `${label}: the hold records a credential digest`)
      const hold = request(behind)!.signIn!
      assert.equal(hold.account, "one", `${label}: the pause names the account the session ran as`)
      assert.deepEqual(request(cut)?.signIn, hold, `${label}: one pause for the session`)
      await delay(40)
      assert.equal(sends, 2, `${label}: no automatic continuation or send while signed out`)
      assert.equal(live.snapshot(id)?.requests.length, 3)

      // New input joins the pause; editing a waiting message keeps it waiting.
      mode = "ok"
      const typed = randomUUID()
      live.submit(id, typed, "sent while signed out")
      assert.equal(request(typed)?.status, "held")
      live.editQueued(id, { requestId: typed, expectedText: "sent while signed out", change: { kind: "resume" } })
      assert.equal(request(typed)?.status, "held", `${label}: a per-message resume can't skip the sign-in`)
      live.editQueued(id, { requestId: typed, expectedText: "sent while signed out", change: { kind: "edit", text: "edited while signed out" } })
      assert.equal(request(typed)?.status, "held")
      assert.equal(request(typed)?.text, "edited while signed out")
      await delay(20)
      assert.equal(sends, 2)

      // Resume refuses until the account is signed in again; the pause survives a restart.
      assert.equal(await live.signInReadiness(id), "signed-out")
      assert.equal(await live.resumeSignIn(id), "signed-out")
      assert.equal(sends, 2, `${label}: Resume before sign-in sends nothing`)
      await live.stop()
      live = owner()
      assert.equal(request(behind)?.status, "held", `${label}: the pause persists through restart`)
      assert.deepEqual(signInPause(live.snapshot(id)!.requests)?.waiting, [behind, typed])
      assert.equal(await live.signInReadiness(id), "signed-out")

      // Signed in again, but it signs out again before the work goes: the
      // continuation is refused unsent and everything waits once more.
      revision = "private-credential-two"
      assert.equal(await live.signInReadiness(id), "ready", `${label}: a new sign-in is seen`)
      mode = "refused-sign-out"
      const opened = opens
      assert.equal(await live.resumeSignIn(id), "resumed")
      await until(() => signInPause(live.snapshot(id)!.requests) !== undefined, `${label}: paused again`)
      assert.equal(opens, opened + 1, `${label}: Resume opens a fresh process`)
      assert.equal(sends, 3, `${label}: only the continuation was tried`)
      const again = signInPause(live.snapshot(id)!.requests)!
      const continuation = again.waiting[0]!
      assert.deepEqual(request(continuation)?.continues, { requestId: cut, reason: "signed-out", auto: true })
      assert.deepEqual(again.waiting, [continuation, behind, typed], `${label}: order is kept`)
      assert.equal(again.cut, undefined, `${label}: the continued turn is no longer the pause's`)
      assert.equal(request(cut)?.signIn, undefined)

      // Signed in for good: two presses admit one continuation, then the queue in order.
      revision = "private-credential-three"
      mode = "ok"
      const results = await Promise.all([live.resumeSignIn(id), live.resumeSignIn(id)])
      assert.deepEqual(results, ["resumed", "resumed"])
      await until(() => request(typed)?.status === "completed", `${label}: the queue drains`)
      assert.equal(sends, 6, `${label}: each waiting message sends exactly once`)
      assert.deepEqual(sent.slice(3).map((text) => text.split("\n\n").at(-1)), [
        request(continuation)!.text, "typed while it ran", "edited while signed out",
      ])
      for (const item of [continuation, behind, typed]) assert.equal(userBlocks(item), 1, `${label}: ${item} shows once`)
      assert.equal(live.snapshot(id)?.requests.filter((item) => item.continues?.requestId === cut).length, 1)
      assert.equal(await live.resumeSignIn(id), "resumed", `${label}: a late press finds nothing to resume`)
      assert.equal(sends, 6)
      assert.equal(signInPause(live.snapshot(id)!.requests), undefined)

      // An unknown outcome waits for review; Resume never sends it again.
      mode = "uncertain-sign-out"
      const unknown = randomUUID()
      live.submit(id, unknown, "outcome unknown")
      await until(() => request(unknown)?.status === "failed", `${label}: unknown outcome settles`)
      assert.equal(request(unknown)?.nativeDelivery?.evidence.kind, "uncertain")
      assert.equal(signInPause(live.snapshot(id)!.requests)?.cut?.outcome, "review")
      mode = "ok"
      assert.equal(await live.resumeSignIn(id, true), "resumed")
      await delay(30)
      assert.equal(sends, 7, `${label}: the unknown attempt is not replayed`)
      assert.equal(request(unknown)?.status, "failed")
      assert.equal(request(unknown)?.signIn, undefined)

      // Out of plan is not a sign-out: nothing pauses behind it.
      mode = "plan"
      const plan = randomUUID()
      live.submit(id, plan, "over plan")
      await until(() => request(plan)?.status === "failed", `${label}: plan failure settles`)
      assert.equal(request(plan)?.failure, "plan")
      assert.equal(signInPause(live.snapshot(id)!.requests), undefined, `${label}: a plan failure never asks for sign-in`)

      // A launch refused before any native session existed holds its first message,
      // and Resume starts the session the first launch would have.
      mode = "ok"
      refuseStart = true
      const fresh = randomUUID()
      const first = randomUUID()
      await live.start(provider, root, { conversationId: fresh, initialRequest: { id: first, text: "first words", attachments: [] } })
      await until(() => request(first, fresh)?.status === "held", `${label}: refused launch holds its message`)
      await until(() => Boolean(request(first, fresh)?.signIn?.credential), `${label}: refused launch records the selected account`)
      assert.equal(request(first, fresh)?.signIn?.account, "one")
      refuseStart = false
      revision = "private-credential-four"
      const before = sends
      assert.equal(await live.resumeSignIn(fresh), "resumed")
      await until(() => request(first, fresh)?.status === "completed", `${label}: the first message goes after Resume`)
      assert.equal(sends, before + 1)
      assert.equal(userBlocks(first, fresh), 1)

      // Two sessions on one account pause in separate outages. Resuming the
      // later one leaves the earlier one paused; the earlier one resumes on
      // the current sign-in without another, and a message removed while it
      // waited is never sent.
      const a = randomUUID()
      const b = randomUUID()
      for (const conversation of [a, b]) {
        await live.start(provider, root, { conversationId: conversation })
        await until(() => live.snapshot(conversation)?.session.status === "ready", `${label}: session ready`)
      }
      revision = "private-credential-five"
      mode = "accepted-sign-out"
      const aCut = randomUUID()
      live.submit(a, aCut, "first outage work")
      await until(() => live.snapshot(a)?.session.status === "running", `${label}: first session runs`)
      const aBehind = randomUUID()
      const aRemoved = randomUUID()
      live.submit(a, aBehind, "kept while signed out")
      live.submit(a, aRemoved, "removed while signed out")
      await until(() => signInPause(live.snapshot(a)!.requests)?.waiting.length === 2, `${label}: first outage pauses its session`)
      live.editQueued(a, { requestId: aRemoved, expectedText: "removed while signed out", change: { kind: "remove" } })
      assert.equal(request(aRemoved, a)?.status, "canceled")
      await until(() => Boolean(signInPause(live.snapshot(a)!.requests)?.hold.credential), `${label}: first outage records its credential`)
      const firstOutage = signInPause(live.snapshot(a)!.requests)!.hold

      revision = "private-credential-six"
      const bCut = randomUUID()
      live.submit(b, bCut, "second outage work")
      await until(() => Boolean(signInPause(live.snapshot(b)!.requests)?.hold.credential), `${label}: second outage pauses the other session`)
      assert.notEqual(signInPause(live.snapshot(b)!.requests)!.hold.credential, firstOutage.credential, `${label}: each outage is its own episode`)

      revision = "private-credential-seven"
      mode = "ok"
      const beforeB = sends
      assert.equal(await live.resumeSignIn(b), "resumed")
      await until(() => signInPause(live.snapshot(b)!.requests) === undefined && live.snapshot(b)?.session.status === "ready", `${label}: the later session continues`)
      await delay(30)
      assert.equal(sends, beforeB + 1, `${label}: resuming one session sends nothing for another`)
      assert.deepEqual(signInPause(live.snapshot(a)!.requests)?.hold, firstOutage, `${label}: the earlier session stays paused`)
      assert.equal(request(aBehind, a)?.status, "held")
      assert.equal(await live.signInReadiness(a), "ready", `${label}: the earlier session needs no second sign-in`)
      assert.equal(await live.resumeSignIn(a), "resumed")
      await until(() => request(aBehind, a)?.status === "completed", `${label}: the earlier session drains`)
      assert.equal(sends, beforeB + 3, `${label}: continuation and kept message only`)
      assert.ok(!sent.slice(-2).some((text) => text.endsWith("removed while signed out")), `${label}: a removed message is never sent`)
      assert.equal(request(aRemoved, a)?.status, "canceled")

      const journalText = (await Promise.all((await readdir(journals, { recursive: true }))
        .map((file) => readFile(join(journals, file), "utf8").catch(() => "")))).join("")
      assert.ok(!journalText.includes("private-credential"), `${label}: credential revisions never reach the journal`)
      assert.ok(!JSON.stringify(live.snapshot(id)).includes("private-credential"))
    } finally { await live.stop(); unregister() }
  }
  console.log("Sign-in pause: six/future harness descriptors; mid-turn sign-out holds the session's work, no auto-continue, new and edited input waits, Resume refused until sign-in, restart persistence, re-sign-out during Resume pauses again, double Resume admits one continuation then the queue in order, unknown outcome not replayed, plan failure not paused, refused first launch resumes into a fresh session, two sessions paused in separate outages resume separately without a second sign-in, a message removed while waiting never sends, no credential revision persisted. Native transports simulated.")
} finally { mock.restoreAll(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }) }
