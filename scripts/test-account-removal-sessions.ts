import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import os from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { removeAccount, selectAccount } from "../electron/accounts.ts"
import { accountRemovalSessions } from "../electron/account-removal-sessions.ts"
import type { AccountRemovalEvent } from "../electron/account-types.ts"
import { launchContext } from "../electron/execution-context.ts"
import { LiveConversations } from "../electron/live-conversations.ts"
import { createProviderHost } from "../electron/providers/host.ts"
import { providerHost } from "../electron/providers/index.ts"
import type { LiveDriverEvent, LiveSessionState } from "../electron/shared.ts"

/**
 * Removing an account sessions run on, through real admission, selection
 * files and the host's removal glue, for every registered live driver and a
 * future one. Native transports are simulated.
 */
const root = await mkdtemp(join(os.tmpdir(), "mako-removal-sessions-"))
mock.method(os, "homedir", () => root)
syncBuiltinESMExports()
async function until(check: () => boolean, what: string) {
  const deadline = performance.now() + 5000
  while (!check()) { assert.ok(performance.now() < deadline, what); await delay(5) }
}
try {
  const peers = providerHost.liveDrivers.list()
  for (const original of [...peers, { ...peers[0]!, provider: "future" }]) {
    const provider = `removal-fixture-${original.provider}`
    const deleted: string[] = []
    const unregister = providerHost.accountCapabilities.register({
      provider, mode: "selectable", label: provider, loginCommand: "fixture", listAccounts: async () => [],
      accountEnv: async (name, base) => ({ ...base, FIXTURE_ACCOUNT: name ?? "default" }),
      selectedAccount: (name) => ({ name: name ?? "default", dir: root }),
      credentialRevision: async () => "fixture-credentials", accountUsage: async () => ({ status: "unavailable" }),
      captureAccount: async () => {},
      removeAccount: async (name) => { deleted.push(name); return {} },
    })
    const sessions = new Map<string, { session: LiveSessionState; emit: (event: LiveDriverEvent) => void; finish?: () => void }>()
    const launchedAs: string[] = []
    let holdTurns = false
    const host = createProviderHost()
    host.liveDrivers.register({ ...original, provider, canResume: true, available: () => true, nativeSource: undefined,
      start: async (_cwd, options) => {
        const account = options.accountLaunch!.account
        launchedAs.push(account.name)
        const nativePath = join(root, `${provider}-${options.conversationId}`)
        await writeFile(nativePath, "fixture native source")
        const context = launchContext("fixture-transport", { kind: "reported", via: "simulated initialization" }, account)
        context.store = { kind: "located", path: nativePath }
        const session: LiveSessionState = { id: options.conversationId, harness: provider, nativeId: `native-${options.conversationId}`, nativePath, cwd: root, status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [], executionContext: context }
        sessions.set(options.conversationId, { session, emit: options.emit! })
        return session
      },
      prompt: async (id, _text, _attachments, _settings, dispatch) => {
        const entry = sessions.get(id)!
        entry.emit({ type: "live-session", session: { ...entry.session, status: "running" } })
        dispatch.report({ kind: "accepted", source: "native-response" })
        const finish = () => {
          entry.emit({ type: "live-update", id, update: { kind: "text", text: "fixture answer" } })
          entry.emit({ type: "live-session", session: entry.session })
        }
        if (holdTurns) entry.finish = finish
        else finish()
      },
      close: async (id) => { sessions.delete(id) },
      cancel: async () => {}, permission: async () => {}, setMode: async () => {},
    })
    const driver = host.liveDrivers.get(provider)!
    const events: AccountRemovalEvent["status"][] = []
    let owner: LiveConversations | undefined
    const removal = accountRemovalSessions(() => owner, (_harness, _name, event) => events.push(event.status))
    owner = new LiveConversations({ root: join(root, `${provider}-journals`), appPath: root, driver: () => driver,
      history: async () => null, emit: () => {}, providerIdleMs: 600_000, providerWarmLimit: 20,
      checkpoint: async () => "fixture-checkpoint", resumeVerdict: async () => ({ kind: "resumable", record: "same" }),
      accountRemoving: removal.removing,
    })
    const live = owner
    const send = async (id: string, text: string) => {
      const requestId = randomUUID()
      live.submit(id, requestId, text)
      await until(() => holdTurns
        ? live.snapshot(id)?.session.status === "running"
        : live.snapshot(id)?.requests.some((request) => request.id === requestId && request.status === "completed") ?? false,
      `${provider}: "${text}" was answered`)
      return requestId
    }
    try {
      await selectAccount(provider, "work")
      const idle = randomUUID()
      const busy = randomUUID()
      await live.start(provider, root, { conversationId: idle, title: "Tidy the changelog" })
      await live.start(provider, root, { conversationId: busy, title: "Migrate the billing tables" })
      await until(() => live.snapshot(idle)?.session.status === "ready" && live.snapshot(busy)?.session.status === "ready", "both sessions open")
      await send(idle, "seed")
      holdTurns = true
      await send(busy, "a long turn")
      await selectAccount(provider, null)

      // The confirmation names each session on the account and what it does.
      const plan = await removal.plan(provider, "work")
      assert.deepEqual(plan, {
        sessions: [
          { conversation: idle, title: "Tidy the changelog" },
          { conversation: busy, title: "Migrate the billing tables", waitingFor: "turn" },
        ],
        runs: 0,
        elsewhere: false,
      }, `${original.provider}: the plan names the idle session and the busy one with what it waits for`)
      assert.deepEqual(await removal.plan(provider, "other"), { sessions: [], runs: 0, elsewhere: false })

      // Idle sessions let go now; the busy one keeps its turn and its account.
      assert.deepEqual(await removeAccount(provider, "work"), { status: "pending" })
      await until(() => live.snapshot(idle)?.session.connection === "hibernated", "the idle session lets go at once")
      assert.equal(live.snapshot(busy)?.session.status, "running", "the running turn is never stopped")
      assert.equal(sessions.has(busy), true)
      await delay(20)
      assert.equal(deleted.length, 0, "credentials stay while the turn runs")
      assert.deepEqual(events, ["pending"])

      // The turn ends; the session lets go and the removal finishes.
      holdTurns = false
      sessions.get(busy)!.finish!()
      await until(() => deleted.includes("work"), "the last session letting go finishes the removal")
      await until(() => events.at(-1) === "removed", "the window hears it finished")
      assert.equal(live.snapshot(busy)?.session.connection, "hibernated")
      assert.equal(live.snapshot(busy)?.requests.at(-1)?.status, "completed", "the turn completed as it would have")

      // Each session's next message reopens on the selected account.
      await send(idle, "after removal")
      await send(busy, "after removal")
      assert.deepEqual(launchedAs, ["work", "work", "default", "default"], `${original.provider}: no launch ever used the removed account again`)
      assert.equal(removal.removing(idle), false)
    } finally {
      removal.dispose()
      await live.stop()
      unregister()
    }
  }
  console.log("Account removal with live sessions: every registered driver and a future one — the plan names idle and busy sessions with what each waits for, idle ones let go at once, a running turn finishes undisturbed and then lets go, the last release removes the account, and next messages reopen on the selected account. Native transports simulated.")
} finally { mock.restoreAll(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }) }
