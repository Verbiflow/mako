import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { applyLiveSnapshot, applyLiveBatch } from "../src/state/live-recovery"
import { acpStore, activeLiveAcp } from "../src/state/acp-state"
import { stagePrompt, removePendingPrompt } from "../src/state/acp-pending"
import { beginStart } from "../src/state/acp-start"
import { autoContinuePending, continueTurnPrompt, promptDelivery, recoverableRequests, turnContinuations, turnStopLabel, turnStops } from "../src/state/prompt-delivery"
import { autoContinueCandidate } from "../electron/contracts/turn-continuation"
import { PromptQueue } from "../src/components/composer/prompt-queue"
import type { LiveSnapshot, LiveRequest } from "../src/lib/types"

const id = "11111111-1111-4111-8111-111111111111"
const request: LiveRequest = {
  id: "22222222-2222-4222-8222-222222222222",
  text: "Review the routing changes.",
  attachments: [],
  status: "queued",
}
const snapshot: LiveSnapshot = {
  session: {
    id,
    harness: "claude",
    cwd: "/disposable",
    connection: "connected",
    status: "ready",
    modes: [],
    currentMode: null,
    configOptions: [],
  },
  revision: 1,
  createdAt: 1,
  base: null,
  blocks: [],
  requests: [],
  permissions: [],
}
function current() {
  const live = activeLiveAcp(acpStore.get())
  assert.ok(live)
  return live
}
acpStore.set({ activeKey: id })
applyLiveSnapshot(snapshot)
stagePrompt(id, request)
const optimistic = current().projection?.messages[0]
assert.equal(
  optimistic?.blocks[0]?.type === "text"
    ? optimistic.blocks[0].text
    : undefined,
  request.text
)
assert.equal(promptDelivery(current()).queued.length, 0)
assert.equal(
  renderToStaticMarkup(<PromptQueue />),
  "",
  "An idle send has no queue UI before any host call"
)
applyLiveSnapshot({
  ...snapshot,
  revision: 2,
  session: { ...snapshot.session, status: "starting", connection: "starting" },
  requests: [request],
})
assert.equal(current().projection?.messages.length, 1)
assert.equal(current().projection?.messages[0]?.id, optimistic?.id)
assert.equal(current().pendingPrompts?.length, 0)
assert.equal(
  renderToStaticMarkup(<PromptQueue />),
  "",
  "Provider startup must not become a queued-message card"
)
applyLiveBatch({
  id,
  revision: 3,
  updates: [{ kind: "user", requestId: request.id, text: request.text }],
  requests: [{ ...request, status: "dispatching" }],
  session: { ...snapshot.session, status: "running" },
})
assert.equal(current().projection?.messages.length, 1)
assert.equal(
  current().projection?.messages[0]?.id,
  optimistic?.id,
  "Host acknowledgment preserves the message identity"
)
const second = {
  ...request,
  id: "33333333-3333-4333-8333-333333333333",
  text: "Also check keyboard navigation.",
}
stagePrompt(id, second)
assert.equal(
  current().projection?.messages.length,
  1,
  "A follow-up cannot split the active answer"
)
assert.equal(promptDelivery(current()).queued[0]?.id, second.id)
const queue = renderToStaticMarkup(<PromptQueue />)
assert.match(queue, /Up next/)
assert.match(queue, /Also check keyboard navigation/)
assert.match(queue, /Edit queued message/)
assert.match(queue, /Remove queued message/)
removePendingPrompt(id, second.id)
assert.equal(promptDelivery(current()).queued.length, 0)
assert.equal(
  current().projection?.messages.length,
  1,
  "A refused follow-up removes only its own optimistic row"
)
const starting = beginStart({
  harness: "claude",
  cwd: "/disposable",
  blocks: [{ type: "user", text: "First prompt", requestId: request.id }],
  hiddenUserPrompt: null,
})
assert.equal(
  starting.projection?.messages.length,
  1,
  "Fresh conversations show their prompt synchronously"
)
// Epochs: a batch numbered by another host generation is not merged onto
// state built by this one, whatever its revision says; a snapshot from the
// new epoch replaces the state outright and later batches follow it.
acpStore.set({ activeKey: id })
applyLiveSnapshot({ ...snapshot, revision: 3, epoch: "host-a", requests: [{ ...request, status: "dispatching" }] })
assert.equal(current().epoch, "host-a")
applyLiveBatch({
  id,
  revision: 4,
  epoch: "host-b",
  updates: [{ kind: "text", text: "from another host" }],
})
assert.equal(current().revision, 3, "a batch from another epoch is ignored, not merged")
assert.equal(current().epoch, "host-a")
applyLiveSnapshot({
  ...snapshot,
  revision: 1,
  epoch: "host-b",
  requests: [{ ...request, status: "uncertain", interruption: { reason: "host-crashed", at: 5 } }],
})
assert.equal(current().epoch, "host-b", "a snapshot from a new epoch replaces the state even at a lower revision")
assert.equal(current().revision, 1)
applyLiveBatch({ id, revision: 2, epoch: "host-b", updates: [{ kind: "text", text: "continues" }] })
assert.equal(current().revision, 2, "the new epoch's own batches apply")
applyLiveBatch({ id, revision: 3, updates: [{ kind: "text", text: "unstamped" }] })
assert.equal(current().revision, 3, "an unstamped batch (an older host) still applies by revision")

// Turn stops: the newest turn Mako cut short offers to be continued while the
// session is idle; a user's Stop and older turns do not.
const stopped: LiveRequest = { ...request, id: "44444444-4444-4444-8444-444444444444", status: "interrupted", interruption: { reason: "stopped", at: 1 } }
const quit: LiveRequest = { ...request, id: "55555555-5555-4555-8555-555555555555", status: "interrupted", interruption: { reason: "host-quit", at: 2 } }
const crashed: LiveRequest = { ...request, id: "66666666-6666-4666-8666-666666666666", status: "uncertain", interruption: { reason: "host-crashed", at: 3 } }
const legacy: LiveRequest = { ...request, id: "77777777-7777-4777-8777-777777777777", status: "interrupted" }
const unconfirmed: LiveRequest = { ...request, id: "88888888-8888-4888-8888-888888888888", status: "uncertain" }
{
  const stops = turnStops([stopped, quit, crashed], false)
  assert.deepEqual(stops.get(stopped.id), { reason: "stopped", continuable: false, automatic: false })
  assert.deepEqual(stops.get(quit.id), { reason: "host-quit", continuable: false, automatic: false }, "only the newest turn is continued")
  assert.deepEqual(stops.get(crashed.id), { reason: "host-crashed", continuable: true, automatic: false })
  assert.equal(turnStops([stopped, quit, crashed], true).get(crashed.id)?.continuable, false, "nothing is offered while a turn runs")
  assert.deepEqual(turnStops([quit], false).get(quit.id), { reason: "host-quit", continuable: true, automatic: false })
  assert.deepEqual(turnStops([stopped], false).get(stopped.id), { reason: "stopped", continuable: false, automatic: false }, "a user's Stop is not offered")
  assert.deepEqual(turnStops([legacy], false).get(legacy.id), { reason: "stopped", continuable: false, automatic: false }, "an older journal's interrupted request is a plain Stop")
  assert.equal(turnStops([unconfirmed], false).has(unconfirmed.id), false, "an unconfirmed delivery is not a stopped turn")
  assert.equal(turnStops([crashed, { ...request, status: "canceled" }], false).get(crashed.id)?.continuable, true, "a canceled request after it does not hide the offer")
  // A provider that ended the turn on its own dropped connection: continuable,
  // named for the provider, and its Continue prompt says what dropped.
  const dropped: LiveRequest = {
    ...request,
    id: "99999999-9999-4999-8999-999999999999",
    status: "interrupted",
    interruption: { reason: "connection-lost", at: 4 },
    failure: "network",
    error: "RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)",
  }
  assert.deepEqual(turnStops([quit, dropped], false).get(dropped.id), { reason: "connection-lost", continuable: true, automatic: false })
  assert.equal(turnStopLabel("connection-lost", "Cursor"), "The connection to Cursor dropped")
  assert.equal(turnStopLabel("host-quit", "Cursor"), "Interrupted when Mako quit")
  assert.match(continueTurnPrompt("connection-lost"), /connection dropped/)
  assert.match(continueTurnPrompt("host-quit"), /Mako closed/)
  assert.ok(!recoverableRequests({ requests: [dropped], blocks: [{ type: "user" as const, requestId: dropped.id, text: "", attachments: [] }] }).length, "a dropped turn on screen is the footer's, not the panel's")
  // While the host has scheduled its own continuation, the footer offers
  // nothing and the thread is still a working one; once Mako's continuation
  // is in the list, it is known as Mako's and the dropped turn is not newest.
  const scheduled: LiveRequest = { ...dropped, interruption: { reason: "connection-lost", at: 4, autoContinue: { at: 6_000 } } }
  assert.deepEqual(turnStops([quit, scheduled], false).get(scheduled.id), { reason: "connection-lost", continuable: false, automatic: true })
  assert.equal(autoContinuePending([quit, scheduled]), true)
  assert.equal(autoContinuePending([quit, dropped]), false)
  assert.equal(autoContinuePending(undefined), false)
  const continuation: LiveRequest = {
    ...request,
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "dispatching",
    text: continueTurnPrompt("connection-lost"),
    continues: { requestId: dropped.id, reason: "connection-lost", auto: true },
  }
  assert.deepEqual([...turnContinuations([quit, dropped, continuation])], [[continuation.id, continuation.continues]])
  assert.deepEqual(turnStops([dropped, continuation], true).get(dropped.id), { reason: "connection-lost", continuable: false, automatic: false })
  assert.equal(autoContinueCandidate([dropped]), dropped, "the newest dropped turn is Mako's to continue")
  assert.equal(autoContinueCandidate([dropped, continuation]), undefined, "a turn already continued is not continued again")
  const droppedAgain: LiveRequest = { ...continuation, status: "interrupted", interruption: { reason: "connection-lost", at: 8 } }
  assert.equal(autoContinueCandidate([dropped, droppedAgain]), undefined, "one attempt per turn: a continuation that drops is the user's")
  assert.equal(autoContinueCandidate([dropped, { ...request, status: "canceled" }]), dropped, "a canceled request after it does not change the candidate")
  assert.equal(autoContinueCandidate([dropped, { ...request, status: "queued" }]), undefined, "a queued prompt behind it is the user's next word")
  assert.equal(autoContinueCandidate([quit]), undefined, "only a dropped connection earns an automatic continuation")
}
// The recovery panel lists a stopped turn only when the transcript does not show it.
{
  const visible = { requests: [crashed, quit, unconfirmed, legacy], blocks: [{ type: "user" as const, requestId: crashed.id, text: "", attachments: [] }] }
  const listed = recoverableRequests(visible).map((item) => item.id)
  assert.ok(!listed.includes(crashed.id), "a crash-interrupted turn on screen is the footer's, not the panel's")
  assert.ok(listed.includes(quit.id) && listed.includes(legacy.id), "stopped turns with no turn on screen stay reviewable")
  assert.ok(listed.includes(unconfirmed.id), "an unconfirmed delivery is always reviewable")
}

console.log(
  "Prompt delivery: immediate idle prompt, stable startup/ack identity, real follow-ups in one queue, scoped rejection, epoch-guarded batches and turn stops passed"
)

// Exercise the production send path with settings discovery deliberately unresolved.
Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
const { installMockBridge } = await import("../src/dev/mock-bridge")
const { providers } = await import("../src/state/providers")
const { getMako } = await import("../src/lib/bridge")
const { sendTo } = await import("../src/state/acp-queue")
const { mock } = await import("node:test")
const fixture = installMockBridge()
fixture.setLiveSnapshot(snapshot)
acpStore.set({ activeKey: id })
applyLiveSnapshot({ ...snapshot, revision: 20 })
fixture.setLiveSnapshot({ ...snapshot, revision: 20 })
const bridge = getMako()
const stopEvents = bridge.onEvent((event) => {
  if (event.type === "live-batch") applyLiveBatch(event.batch)
})
const gate = Promise.withResolvers<void>()
const load = providers.load
const delayed = mock.method(
  providers,
  "load",
  async (...args: Parameters<typeof load>) => {
    await gate.promise
    return load(...args)
  }
)
const sent = sendTo(id, "Visible before settings discovery completes")
const pendingBlock = current().projection?.messages.at(-1)?.blocks[0]
assert.equal(
  pendingBlock?.type === "text" ? pendingBlock.text : undefined,
  "Visible before settings discovery completes"
)
assert.equal(renderToStaticMarkup(<PromptQueue />), "")
const visibleId = current().projection?.messages.at(-1)?.id
assert.equal(
  await Promise.race([
    sent,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Sending waited for display-only discovery")),
        1000
      )
    ),
  ]),
  true
)
gate.resolve()
const discovery = delayed.mock.calls[0]
if (discovery) await discovery.result
assert.equal(await sent, true)
assert.equal(
  current().projection?.messages.filter((message) => message.role === "user")
    .length,
  1
)
assert.equal(
  current().projection?.messages.find((message) => message.role === "user")?.id,
  visibleId
)
delayed.mock.restore()
const cachedDiscovery = mock.method(providers, "load", async () => {
  throw new Error("Warm send must not discover models")
})
assert.equal(
  await sendTo(id, "Use the settings already shown in the composer"),
  true
)
assert.equal(cachedDiscovery.mock.callCount(), 0)
cachedDiscovery.mock.restore()
stopEvents()
Reflect.deleteProperty(globalThis, "window")
console.log(
  "Production send reaches the host before display discovery completes and reconciles the acknowledged message without duplicates"
)
