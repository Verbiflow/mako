import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { SignInRecovery } from "../src/components/composer/sign-in-recovery"
import { accountsStore, removalNotice, type ProviderAccount } from "../src/state/accounts"
import { acpStore, type LiveAcpConversation } from "../src/state/acp-state"
import { syncThreadStatus } from "../src/state/acp-live"
import { selectAcpPresence } from "../src/state/acp-presence"
import { notificationsStore } from "../src/state/notifications"
import { threadsStore } from "../src/state/thread-store"
import { fixtureCapabilities } from "../src/dev/harness-fixtures"
import { promptDelivery, turnStopLabel, turnStops } from "../src/state/prompt-delivery"
import { holdForSignIn, releaseSignIn, signInPause } from "../electron/contracts/sign-in-hold"
import { continueTurnPrompt } from "../electron/contracts/turn-continuation"
import type { LiveRequest, SignInHold } from "../electron/contracts/live-conversations"
import type { LiveSessionState } from "../electron/contracts/providers-acp"

/**
 * Work paused on a sign-out: the pure hold and release, and what the card
 * above the composer says for each kind of pause, rendered from fixture stores.
 */

const hold: SignInHold = { harness: "claude", account: "default", credential: "digest", at: 10 }
const accepted = { attemptId: "a", bindingId: "b", ownerEpoch: "e", evidence: { kind: "accepted" as const, source: "native-response" as const } }
const refused = { ...accepted, evidence: { kind: "not-accepted" as const, source: "preflight" as const, reason: "signed out" } }

// Hold: queued work waits, the turn that ended keeps its outcome, the user's own pause stays theirs.
const held = holdForSignIn([
  { id: "done", text: "earlier", attachments: [], status: "completed" },
  { id: "cut", text: "work", attachments: [], status: "failed", failure: "auth", nativeDelivery: accepted },
  { id: "mine", text: "paused by me", attachments: [], status: "held" },
  { id: "next", text: "next", attachments: [], status: "queued", accountSwitch: { reason: "selection", waitingFor: "turn" } },
], hold, "cut")
assert.deepEqual(held.map((request) => [request.id, request.status, Boolean(request.signIn)]), [
  ["done", "completed", false], ["cut", "interrupted", true], ["mine", "held", false], ["next", "held", true],
])
assert.deepEqual(held[1]?.interruption, { reason: "signed-out", at: 10 }, "an accepted turn is cut short, not failed")
assert.equal(held[3]?.accountSwitch, undefined, "the pause replaces a pending account switch")
const unsent = holdForSignIn([{ id: "r", text: "x", attachments: [], status: "failed", failure: "auth", error: "401", nativeDelivery: refused }], hold, "r")[0]!
assert.equal(unsent.status, "held", "a refused, unsent message waits to go again")
assert.equal(unsent.error, undefined)
assert.equal(unsent.nativeDelivery?.evidence.kind, "not-accepted", "its receipt keeps it from showing twice")
const unknown = holdForSignIn([{ id: "u", text: "x", attachments: [], status: "uncertain", nativeDelivery: { ...accepted, evidence: { kind: "uncertain", reason: "lost" } } }], hold, "u")[0]!
assert.equal(unknown.status, "uncertain", "an unknown outcome is never turned into something to send")
assert.deepEqual(signInPause([unknown])?.cut, { requestId: "u", outcome: "review" })

// Release: the continuation goes first, waiting messages follow in order, and no marker is left.
const pause = signInPause(held)!
assert.deepEqual(pause.waiting, ["next"])
assert.deepEqual(pause.cut, { requestId: "cut", outcome: "continue" })
const continuation: LiveRequest = { id: "cont", text: continueTurnPrompt("signed-out"), attachments: [], status: "queued", continues: { requestId: "cut", reason: "signed-out", auto: true } }
const released = releaseSignIn(held, continuation)
assert.deepEqual(released.map((request) => [request.id, request.status]), [
  ["done", "completed"], ["cut", "interrupted"], ["mine", "held"], ["cont", "queued"], ["next", "queued"],
])
assert.ok(released.every((request) => !request.signIn))
assert.equal(signInPause(released), undefined)
assert.deepEqual(releaseSignIn([{ ...held[1]! }], continuation).map((request) => request.id), ["cut", "cont"], "with nothing waiting it goes last")
assert.equal(signInPause([{ ...held[3]!, status: "canceled" }]), undefined, "a removed message is not the pause's")

// The transcript never offers its own Continue while the card owns the turn.
assert.equal(turnStopLabel("signed-out", "Claude Code"), "Claude Code signed out")
assert.equal(turnStops([held[1]!], false).get("cut")?.continuable, false)
assert.equal(turnStops([released[1]!], false).get("cut")?.continuable, true)
assert.match(continueTurnPrompt("signed-out"), /sign-in expired.*renewed/)
assert.equal(promptDelivery({ session: { status: "failed" }, blocks: [], requests: held }).queued.find((item) => item.id === "next")?.signIn, hold)

const accounts: ProviderAccount[] = [
  { harness: "claude", name: "default", email: "personal@example.com", active: true, route: "native" },
  { harness: "claude", name: "account-work", email: "work@example.com", active: false, source: "mako", route: "managed" },
]
accountsStore.set({
  providers: [{ provider: "claude", label: "Claude Code", mode: "selectable", loginCommand: "claude auth login", nativeLogin: true }],
  accounts,
  loadedAt: Date.now(),
})
const session: LiveSessionState = { id: "conversation", harness: "claude", cwd: "/repo", status: "failed", connection: "connected", modes: [], currentMode: null, configOptions: [] }
function render(requests: LiveRequest[]): string {
  const conversation: LiveAcpConversation = {
    kind: "live", key: "conversation", draftKey: "conversation", harness: "claude", cwd: "/repo",
    session, requests, permission: null, sending: false, canceling: false,
    blocks: [], queued: [], hiddenUserPrompt: null, createdAt: 0, updatedAt: 0,
  }
  acpStore.set({ activeKey: conversation.key, conversations: { [conversation.key]: conversation } })
  return renderToStaticMarkup(<SignInRecovery />)
}

assert.equal(render([{ id: "done", text: "earlier", attachments: [], status: "completed" }]), "", "silent with nothing paused")
const terminal = render(held)
assert.match(terminal, /Claude Code signed out of personal@example\.com/)
assert.match(terminal, /The turn stopped partway; its work so far is kept\. 1 message waits to send\./)
assert.match(terminal, />claude auth login</, "the terminal's login names the CLI command")
assert.match(terminal, />Resume anyway</)
assert.match(terminal, />Use another account</)
assert.doesNotMatch(terminal, />Sign in again</, "Mako can't renew the terminal's own login")
assert.doesNotMatch(terminal, />Resume</, "no plain Resume before a new sign-in is seen")
assert.match(terminal, /data-sign-in-recovery="checking"/)

const work = { ...hold, account: "account-work" }
const kept = render(held.map((request) => request.signIn ? { ...request, signIn: work } : request))
assert.match(kept, /Claude Code signed out of work@example\.com/)
assert.match(kept, />Sign in again</, "an account Mako keeps signs in again from the card")
assert.doesNotMatch(kept, /claude auth login/)

const review = render([unknown, { id: "w1", text: "a", attachments: [], status: "held", signIn: hold }, { id: "w2", text: "b", attachments: [], status: "held", signIn: hold }])
assert.match(review, /can’t tell whether your last message reached Claude Code, so it stays below for you to review\. 2 messages wait to send\./)

// A turn cut short by a sign-out waits on the person: one ask, never a
// failure, and the row needs input until Resume.
threadsStore.set({ descriptors: [{ provider: "claude", displayName: "Claude Code", resumable: true, live: true, capabilities: fixtureCapabilities("claude") }] })
const signedOut: LiveAcpConversation = {
  kind: "live", key: "paused", draftKey: "paused", harness: "claude", cwd: "/repo", threadPath: "/sessions/paused.jsonl",
  session: { ...session, id: "paused", error: "Not logged in" }, requests: held, permission: null, sending: false, canceling: false,
  blocks: [], queued: [], hiddenUserPrompt: null, createdAt: 0, updatedAt: 0, revision: 1,
}
acpStore.set({ activeKey: undefined, conversations: { paused: signedOut } })
syncThreadStatus(signedOut, "running")
syncThreadStatus({ ...signedOut, revision: 2 }, "failed")
const outcomes = notificationsStore.get().items.filter((item) => item.subject.id === "thread:/sessions/paused.jsonl")
assert.deepEqual(outcomes.map((item) => [item.kind, item.body]), [["ask", "Claude Code signed out. Sign in again, then Resume."]], "announced once, as needing you, never as failed")
assert.deepEqual(threadsStore.get().attention["/sessions/paused.jsonl"], { kind: "needs-permission", since: hold.at, detail: "Claude Code signed out. Sign in again, then Resume." })
assert.equal(selectAcpPresence(acpStore.get()).find((presence) => presence.key === "paused")?.status, "needs-permission", "an unbound session's row needs input too")

// Removing an account whose key Cursor still accepts says so, with when it lapses.
const removal = removalNotice("Cursor", { reason: "Cursor couldn't be reached (fetch failed)", expiresAt: "2026-11-03T12:00:00.000Z", manageUrl: "https://cursor.com/dashboard?tab=integrations" })
assert.equal(removal.title, "Cursor still accepts this account's key")
assert.match(removal.description, /^Mako removed the account, but Cursor couldn't be reached \(fetch failed\)\. The key Mako made for it keeps working until .*2026 unless you revoke it\.$/)
assert.match(removalNotice("Cursor", { reason: "Cursor's key list doesn't show this key", manageUrl: "https://cursor.com" }).description, /keeps working until you revoke it\.$/)

console.log("Sign-in recovery: hold (cut short, unsent waits, unknown kept, own pause untouched), release order and markers, transcript defers to the card, and the card's terminal, Mako-kept and review variants render; a removal Cursor didn't confirm is reported")
