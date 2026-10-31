/**
 * The compact live form (`live-form.ts`): a window reads a conversation's batches written compact to the state their
 * whole form leaves, a batch it can't read against what it holds sends it to read the conversation again, and the local
 * host gives each window the form it said it reads, the whole form's notice to read again where it has no other.
 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import { COMPACT_LIVE_FORM, LIVE_FORM } from "@mako/protocol/live-form"
import { reduceLiveUpdates, type LiveUpdate } from "@mako/sessions/live-content"
import type { RecordRef } from "@mako/sessions/entries"
import { toast } from "sonner"
import type { ConversationControl } from "@mako/host/contracts/conversation-control"
import { compactLiveBatch, requestsAfter, type CompactLiveBatch, type LiveBatch, type LiveRequest, type LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { encodeRuntimeEvent, readEventLine } from "@mako/host/contracts/runtime-value"
import type { RuntimePacket } from "@mako/host/contracts/runtime"
import { startWebHost } from "@mako/host/transport/server"
import { subscribeRuntime } from "@mako/host/transport/connection"
import { auditId, auditSnapshot } from "./performance-audit-fixtures"

Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
const { installMockBridge } = await import("../src/dev/mock-bridge")
const { getMako } = await import("../src/lib/bridge")
const { acpStore } = await import("../src/state/acp-state")
const { applyLiveBatch, applyLiveSnapshot } = await import("../src/state/live-recovery")
installMockBridge()
mock.method(toast, "error", () => "fixture")

/** What a window shows of a conversation, which both forms must leave alike. */
function shown(id: string) {
  const conversation = acpStore.get().conversations[id]
  assert.ok(conversation?.kind === "live", `${id} is open`)
  const { blocks, requests, control, revision, session } = conversation
  return { blocks, requests, control, revision, status: session.status }
}

const control = (coveredBlocks: number): ConversationControl => ({
  activeBindingId: "binding-1",
  bindings: [{ id: "binding-1", provider: "codex", coveredBlocks, includesBase: true }],
  transfers: [],
  merges: [],
})

/**
 * A conversation's owner, writing each batch whole and compact against what it held at the revision before, as
 * `LiveConversations` flushes; `whole` and `compact` are two windows, each opened on the same snapshot under its own id.
 */
function owner(snapshot: LiveSnapshot) {
  const whole = auditId(900)
  const compact = auditId(901)
  let held = { blocks: snapshot.blocks, requests: snapshot.requests, control: snapshot.control }
  applyLiveSnapshot({ ...snapshot, session: { ...snapshot.session, id: whole } })
  applyLiveSnapshot({ ...snapshot, session: { ...snapshot.session, id: compact } })
  let revision = snapshot.revision
  let wholeBytes = 0
  let compactBytes = 0
  return {
    whole,
    compact,
    get saved() { return 1 - compactBytes / wholeBytes },
    /** The next batch, from `fields`; `deliver` false writes it without giving it to the compact window. */
    send(fields: Omit<LiveBatch, "id" | "revision">, deliver = true): CompactLiveBatch {
      revision += 1
      const batch: LiveBatch = { id: whole, revision, ...fields }
      const written = compactLiveBatch(batch, { blocks: held.blocks, requests: held.requests, ...(held.control && { control: held.control }) })
      held = { blocks: reduceLiveUpdates(held.blocks, batch.updates), requests: requestsAfter(held.requests, batch) ?? held.requests, control: batch.control ?? held.control }
      const line = JSON.stringify({ type: "live-batch", batch })
      const compactLine = JSON.stringify({ type: "live-batch", batch: { ...written, id: compact } })
      wholeBytes += line.length
      compactBytes += compactLine.length
      applyLiveBatch(JSON.parse(line).batch)
      const heard: CompactLiveBatch = JSON.parse(compactLine).batch
      if (deliver) applyLiveBatch(heard)
      return heard
    },
  }
}

const snapshot = { ...auditSnapshot(2, "codex"), control: control(6) }
const reading = mock.method(getMako(), "liveSnapshot", async () => { throw new Error("read again") })
const conversation = owner(snapshot)
const same = (why: string) => assert.deepEqual(shown(conversation.compact), shown(conversation.whole), why)
const [request] = snapshot.requests.slice(-1)
assert.ok(request)

// A turn: its answer streamed a few words at a time, a call between, its request settled, its binding grown.
const answer = (id: string, text: string, stream?: RecordRef): LiveUpdate => ({ kind: "text", id, text, ...(stream && { stream }) })
conversation.send({ updates: [answer("text-new", "The ")], sessionChanges: { status: "running" }, requestChanges: [{ ...request, status: "dispatching" } satisfies LiveRequest] })
same("a new answer and a request changed")
for (const [index, words] of ["answer ", "goes ", "on ", "word ", "by ", "word."].entries()) {
  const heard = conversation.send({ updates: [answer("text-new", words, { file: "/records/rollout.jsonl", ranges: [[index * 10, index * 10 + 9]] })] })
  if (index > 0) assert.equal(heard.updates[0]?.kind, "more", "more of the last answer names neither it nor its file")
  same(`the answer streamed, ${index + 1}`)
}
conversation.send({ updates: [{ kind: "tool", id: "tool-new", title: "Run tests", status: "in_progress", input: "npm test", output: "", stream: { file: "/records/rollout.jsonl", ranges: [[80, 90]] } }] })
const output = conversation.send({ updates: [{ kind: "tool-update", id: "tool-new", outputAppend: "ok 1\n", stream: { file: "/records/rollout.jsonl", ranges: [[90, 99]] } }] })
const update = output.updates[0]
assert.ok(update?.kind === "tool-update" && update.stream && !("file" in update.stream), "a call's frames name no file its call already names")
same("a call and its output")
const settled = conversation.send({ updates: [answer("text-after", "Done.")], sessionChanges: { status: "ready" }, requestChanges: [{ ...request, status: "completed" }], control: control(12) })
assert.ok(settled.requestPatches?.length && !settled.requestChanges && settled.bindingPatches?.length && !settled.control, "a held request and binding change as their fields")
same("a request settled and the binding grown")
assert.ok(conversation.saved > 0.1, `the compact form says the turn in fewer bytes than the whole form (${Math.round(conversation.saved * 100)}% fewer)`)
assert.equal(reading.mock.callCount(), 0, "nothing read again while every batch reads against what the window holds")

// A batch the compact window missed: the next one doesn't read against what it holds, so it's read again, not misread.
conversation.send({ updates: [answer("text-after", " Missed.")] }, false)
const blocks = shown(conversation.compact).blocks
conversation.send({ updates: [answer("text-after", " After.")] })
await tick()
assert.equal(reading.mock.callCount(), 1, "a gap is read again")
assert.deepEqual(shown(conversation.compact).blocks, blocks, "and nothing of the batch after it is applied")

// A batch read against a window that never held its last block (a `more` with nothing to go on) is read again too.
const stray = auditId(902)
applyLiveSnapshot({ ...snapshot, session: { ...snapshot.session, id: stray }, blocks: [...snapshot.blocks, { type: "user", text: "Next" }], revision: 1 })
applyLiveBatch({ id: stray, revision: 2, form: COMPACT_LIVE_FORM, updates: [{ kind: "more", text: "lost" }] })
await tick()
assert.equal(reading.mock.callCount(), 2, "an update that can't go on from the window's blocks is read again")
reading.mock.restore()

// The local host: each subscriber hears a batch in the form it said it reads; a batch heard only compact (from another
// device) reaches one that reads only the whole form as the notice to read its conversation again.
const root = await mkdtemp(join(tmpdir(), "mako-live-form-"))
const socket = join(root, "host.sock")
const host = await startWebHost(socket, async () => "null", async () => new Response("fixture"), undefined, { protocol: 1, instanceId: randomUUID(), pid: process.pid, version: "fixture", methods: [] })
const heard = { old: new Array<string>(), new: new Array<string>() }
const ready = { old: false, new: false }
const listen = (who: "old" | "new") => (packet: RuntimePacket) => {
  if (packet.channel === "ready") ready[who] = true
  else if ("payload" in packet && packet.type === "live-batch") heard[who].push(packet.payload)
}
const stops = [subscribeRuntime(socket, randomUUID(), listen("old"), () => {}), subscribeRuntime(socket, randomUUID(), listen("new"), () => {}, { live: LIVE_FORM })]
const wait = async (what: string, done: () => boolean) => {
  for (const deadline = Date.now() + 2_000; !done(); await new Promise((resolve) => setTimeout(resolve, 5))) if (Date.now() > deadline) assert.fail(what)
}
try {
  await wait("both subscribed", () => ready.old && ready.new)
  const id = auditId(903)
  const batch: LiveBatch = { id, epoch: "e1", revision: 4, updates: [answer("a", " more")] }
  const compact = compactLiveBatch(batch, { blocks: [{ type: "text", id: "a", text: "some" }], requests: [] })
  host.event({ type: "live-batch", batch, compact })
  await wait("the batch heard", () => heard.old.length === 1 && heard.new.length === 1)
  assert.deepEqual(JSON.parse(heard.old[0]!), { type: "live-batch", batch }, "the whole form to a subscriber that said none")
  assert.deepEqual(JSON.parse(heard.new[0]!), { type: "live-batch", batch: compact }, "the compact form to one that reads it")
  // Relayed from the gateway as heard, compact: a line read by its first characters.
  const line = JSON.stringify({ type: "live-batch", batch: { ...compact, revision: 5 } })
  const read = readEventLine(line)
  assert.deepEqual(read && { conversation: read.conversation, form: read.form }, { conversation: id, form: COMPACT_LIVE_FORM })
  host.conversationEvent({ type: "live-batch", conversation: id, payload: read!.payload, form: COMPACT_LIVE_FORM })
  await wait("the relayed batch heard", () => heard.old.length === 2 && heard.new.length === 2)
  assert.deepEqual(JSON.parse(heard.old[1]!), { type: "live-batch", batch: { id, epoch: "e1", revision: 5, updates: [], historyChanged: true } }, "one that reads only the whole form reads it again")
  assert.equal(heard.new[1], line, "one that reads the compact form hears it as it came")
  // Any other event reaches both alike.
  const other = encodeRuntimeEvent({ type: "live-batch", batch: { id, epoch: "e1", revision: 6, updates: [], historyChanged: true } })
  host.conversationEvent(other)
  await wait("a whole batch heard", () => heard.old.length === 3 && heard.new.length === 3)
  assert.equal(heard.old[2], heard.new[2])
} finally {
  for (const stop of stops) stop()
  host.close()
  await rm(root, { recursive: true, force: true })
}
console.log("live form: compact batches read alike, gaps and strays read again, each subscriber served its form")
