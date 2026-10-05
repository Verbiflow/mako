import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { AccountSwitchNotice } from "../src/components/composer/account-notice"
import { accountReading, stopSwitches, waitText } from "../src/lib/account-switch"
import { accountsStore, type ProviderAccount } from "../src/state/accounts"
import { acpStore, type LiveAcpConversation } from "../src/state/acp-state"
import type { ExecutionContext } from "../electron/contracts/execution-context"
import type { LiveRequest } from "../electron/contracts/live-conversations"
import type { LiveSessionState } from "../electron/contracts/providers-acp"

/**
 * Accounts switch globally and never stick to a session: what the line above
 * the composer says for each state, rendered from fixture stores.
 */

const accounts: ProviderAccount[] = [
  { harness: "codex", name: "default", email: "codex@example.com", active: false },
  { harness: "codex", name: "personal", email: "personal@work.dev", active: true, source: "mako" },
]

function context(name: string, principal: string, confirmation?: ExecutionContext["confirmation"]): ExecutionContext {
  return {
    transport: "fixture",
    runtime: { kind: "unavailable", reason: "fixture" },
    account: { kind: "configured", name, managed: name !== "default" },
    identity: { kind: "reported", principal, backend: "subscription", via: "fixture" },
    credential: { kind: "unavailable", reason: "fixture" },
    confirmation,
    service: { kind: "unavailable", reason: "fixture" },
    store: { kind: "unavailable", reason: "fixture" },
  }
}

function session(executionContext: ExecutionContext, change: Partial<LiveSessionState> = {}): LiveSessionState {
  return {
    id: "conversation", harness: "codex", cwd: "/repo", status: "ready", connection: "connected",
    modes: [], currentMode: null, configOptions: [], executionContext, ...change,
  }
}

function live(state: LiveSessionState, requests: LiveRequest[] = []): LiveAcpConversation {
  return {
    kind: "live", key: "conversation", draftKey: "conversation", harness: "codex", cwd: "/repo",
    session: state, requests, permission: null, sending: false, canceling: false,
    blocks: [], queued: [], hiddenUserPrompt: null, createdAt: 0, updatedAt: 0,
  }
}

const onDefault = context("default", "codex@example.com", { kind: "matches", principal: "codex@example.com" })
const onPersonal = context("personal", "personal@work.dev", { kind: "matches", principal: "personal@work.dev" })

assert.equal(accountReading(live(session(onPersonal)), accounts), null, "silent when the session runs as the selected account")
assert.deepEqual(accountReading(live(session(onDefault)), accounts), {
  kind: "pending", running: "codex@example.com", selected: "personal@work.dev",
}, "a session on the old account says the next message switches it")
assert.equal(accountReading(live(session(onDefault, { status: "closed" })), accounts), null)

const waiting: LiveRequest = {
  id: "held", text: "summarize", attachments: [], status: "queued",
  accountSwitch: { reason: "selection", waitingFor: "background" },
}
assert.deepEqual(accountReading(live(session(onDefault, { backgroundTasks: 1 }), [waiting]), accounts), {
  kind: "waiting", selected: "personal@work.dev", waitingFor: "background",
})
assert.equal(waitText("background"), "its background work finishes")
assert.ok(stopSwitches("background") && stopSwitches("subagents") && stopSwitches("turn"))
assert.ok(!stopSwitches("approval") && !stopSwitches("children"), "Stop is offered only where it frees the session")

const wrong = context("personal", "someone@example.com", { kind: "differs", principal: "someone@example.com", expected: "personal@work.dev" })
assert.deepEqual(accountReading(live(session(wrong)), accounts), {
  kind: "differs", principal: "someone@example.com", expected: "personal@work.dev",
})
assert.equal(accountReading(live(session(wrong, { connection: "hibernated" })), accounts), null,
  "a retired session doesn't keep warning; its next launch is confirmed again")

const unverified = { ...onDefault, identity: { kind: "unavailable" as const, reason: "fixture" }, confirmation: { kind: "unavailable" as const, reason: "fixture" } }
assert.deepEqual(accountReading(live(session(unverified)), accounts), {
  kind: "pending", running: "codex@example.com", selected: "personal@work.dev",
}, "an unverifiable harness still names the account it launched with")

accountsStore.set({
  providers: [{ provider: "codex", label: "Codex", mode: "selectable", loginCommand: "codex login" }],
  accounts,
  loadedAt: Date.now(),
})
function render(conversation: LiveAcpConversation): string {
  acpStore.set({ activeKey: conversation.key, conversations: { [conversation.key]: conversation } })
  return renderToStaticMarkup(<AccountSwitchNotice />)
}
assert.equal(render(live(session(onPersonal))), "")
assert.match(render(live(session(onDefault))), /This session runs as codex@example\.com\. Your next message switches it to personal@work\.dev\./)
assert.match(render(live(session(onDefault, { status: "running" }))), /This turn runs as codex@example\.com\. The next message switches to personal@work\.dev\./)
const held = render(live(session(onDefault, { backgroundTasks: 1 }), [waiting]))
assert.match(held, /Switches to personal@work\.dev when its background work finishes\. Your message is waiting\./)
assert.match(held, />Stop and switch</)
assert.match(render(live(session(onDefault, { backgroundTasks: 1 }))),
  /Background work runs as codex@example\.com\. A new message waits for it, then switches to personal@work\.dev\./,
  "background work holds the old account until it finishes, so the line doesn't promise the next message switches")

// The session's account is being removed: the line says when it goes.
accountsStore.set({
  providers: [{ provider: "codex", label: "Codex", mode: "selectable", loginCommand: "codex login" }],
  accounts: [
    { harness: "codex", name: "default", email: "codex@example.com", active: true },
    { harness: "codex", name: "personal", email: "personal@work.dev", active: false, source: "mako", removing: true },
  ],
  loadedAt: Date.now(),
})
assert.match(render(live(session(onPersonal, { status: "running" }))),
  /This turn runs as personal@work\.dev, which Mako removes when the turn ends\. The next message uses codex@example\.com\./)
assert.match(render(live(session(onPersonal, { backgroundTasks: 2 }))),
  /Background work runs as personal@work\.dev, which Mako removes when it finishes\. A new message waits for it, then uses codex@example\.com\./)
assert.match(render(live(session(onPersonal))), /This session runs as personal@work\.dev\. Your next message switches it to codex@example\.com\./)

const mismatch = render(live(session(wrong)))
assert.match(mismatch, /Codex is signed in as someone@example\.com, not personal@work\.dev\./)
assert.match(mismatch, />Settings</)
assert.match(mismatch, /text-caution/)

console.log("Account switching: silent when matched; pending, background-held, being-removed, waiting (Stop only where it frees the session) and wrong-identity lines render; retired sessions stop warning")
