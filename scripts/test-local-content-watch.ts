import assert from "node:assert/strict"
import { mock } from "node:test"
import { z } from "zod"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { setImmediate as tick } from "node:timers/promises"
import { startWebHost } from "@mako/host/transport/server"
import { invokeRuntime, subscribeRuntime } from "@mako/host/transport/connection"
import { encodeRuntimeEvent, decodeRuntimeEvent } from "@mako/host/contracts/runtime-value"
import { ROSTER_LIVE_FORM } from "@mako/protocol/live-form"
import { LOCAL_CONTENT_CHANNEL, LOCAL_CONTENT_LIMIT, LocalContentReceiptSchema, withoutLiveContent } from "@mako/host/contracts/local-content-watch"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { TURN_REPLY_CHARS, turnReplyOf, type LiveBatch, type LiveRequest, type LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { auditId, auditSnapshot } from "./performance-audit-fixtures"
import { removeScratch } from "./lib/scratch-processes.mjs"

Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
Object.assign(globalThis, { requestAnimationFrame: (run: () => void) => setTimeout(run, 16), cancelAnimationFrame: clearTimeout })
const { installMockBridge } = await import("../src/dev/mock-bridge")
installMockBridge()
const { getMako } = await import("../src/lib/bridge")
const { acpStore } = await import("../src/state/acp-state")
const { applyLiveSnapshot, applyLiveBatch, hydrateLive, unloadLive } = await import("../src/state/live-recovery")
const { localContentUnion, watchLocalContent, syncLocalContent, resetLocalContent } = await import("../src/state/local-content-watch")
const { transcriptReaders, liveReadingSource } = await import("../src/state/transcript-reading")
const { viewer } = await import("../src/state/viewer")
const { installNotificationEnvironment } = await import("../src/state/notifications")
const { AudioFeedback } = await import("../src/lib/audio-feedback")
mock.method(AudioFeedback.prototype, "play", async () => {})

const root = await mkdtemp(join(tmpdir(), "mako-content-watch-"))
const socket = join(root, "host.sock")
const client = randomUUID(), legacy = randomUUID(), other = randomUUID()
let generation = randomUUID(), sequence = 0
const source = new Map<string, LiveSnapshot>()
const a = auditId(700), b = auditId(701), c = auditId(702)
for (const id of [a, b, c]) source.set(id, { ...auditSnapshot(0, "codex"), session: { ...auditSnapshot(0, "codex").session, id },
  threadId: id, sessionId: id, epoch: "fixture-epoch" })
const until = async (why: string, check: () => boolean) => {
  const deadline = Date.now() + 5000
  while (!check()) { assert.ok(Date.now() < deadline, why); await tick() }
}
function gate() {
  let open = () => {}
  const wait = new Promise<void>(resolve => { open = resolve })
  return { wait, open }
}
let pause: { arrived: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | undefined
let reads = 0
const host = await startWebHost(socket, async (channel, args) => {
  assert.equal(channel, "mako:live-read")
  const id = z.string().parse(args[0])
  const snapshot = structuredClone(source.get(id))
  assert.ok(snapshot)
  reads++
  const held = pause
  pause = undefined
  if (held) { held.arrived.open(); await held.release.wait }
  const data = JSON.stringify(snapshot)
  return JSON.stringify({ record: randomUUID(), offset: 0, total: data.length, data, next: null })
}, async () => new Response(null, { status: 404 }))
const delivered: LiveBatch[] = [], oldPackets: LiveBatch[] = [], otherPackets: LiveBatch[] = []
let ready = 0
const attach = () => subscribeRuntime(socket, client, packet => {
  if (packet.channel === "ready") { ready++; return }
  const event = decodeRuntimeEvent<HostEvent>(packet.payload)
  assert.equal(event.type, "live-batch")
  delivered.push(event.batch)
  applyLiveBatch(event.batch)
}, () => {}, { history: true, live: ROSTER_LIVE_FORM, contentGeneration: generation })
const passive = (id: string, packets: LiveBatch[], contentGeneration?: string) => subscribeRuntime(socket, id, packet => {
  if (packet.channel === "ready") { ready++; return }
  const event = decodeRuntimeEvent<HostEvent>(packet.payload)
  assert.equal(event.type, "live-batch")
  packets.push(event.batch)
}, () => {}, { history: true, live: ROSTER_LIVE_FORM, contentGeneration })
let close = attach()
const closeLegacy = passive(legacy, oldPackets)
const otherGeneration = randomUUID()
const closeOther = passive(other, otherPackets, otherGeneration)
const bridge = getMako()
bridge.watchLiveContent = async conversations => {
  const started = generation, sent = ++sequence
  const receipt = LocalContentReceiptSchema.parse(await invokeRuntime(socket, client, LOCAL_CONTENT_CHANNEL,
    [{ generation: started, sequence: sent, conversations }]))
  assert.equal(generation, started, "old connection cannot acknowledge new interest")
  assert.equal(receipt.sequence, sent)
  return receipt.generation
}
const chunk = z.object({ record: z.uuid(), offset: z.number(), total: z.number(), data: z.string(), next: z.null() })
const liveRead = mock.method(bridge, "liveRead", async (...args: Parameters<typeof bridge.liveRead>) =>
  chunk.parse(await invokeRuntime(socket, client, "mako:live-read", args)))
let stop = () => {}
function change(id: string, text: string): Extract<HostEvent, { type: "live-batch" }> {
  const before = source.get(id)!
  const revision = before.revision! + 1
  source.set(id, { ...before, revision, blocks: [...before.blocks, { type: "text", id: `answer-${revision}`, text }] })
  return { type: "live-batch", batch: { id, epoch: before.epoch, revision, updates: [{ kind: "text", id: `answer-${revision}`, text }] } }
}
async function sent(event: HostEvent) {
  const previous = delivered.length
  host.event(event)
  await until("event reached all windows", () => delivered.length > previous && oldPackets.length === delivered.length && otherPackets.length === delivered.length)
}
function sameContent(id: string): void {
  assert.deepEqual(acpStore.get().conversations[id]?.blocks, source.get(id)?.blocks)
  assert.equal(acpStore.get().conversations[id]?.revision, source.get(id)?.revision)
}
try {
  await until("three streams ready", () => ready === 3)
  await invokeRuntime(socket, other, LOCAL_CONTENT_CHANNEL, [{ generation: otherGeneration, sequence: 1, conversations: [] }])
  acpStore.set({ conversations: {}, activeKey: null })
  for (const snapshot of source.values()) { applyLiveSnapshot(snapshot); unloadLive(snapshot.session.id) }
  stop = watchLocalContent()
  await syncLocalContent()
  await sent(change(a, "hidden before promotion"))
  assert.equal(delivered.at(-1)?.contentOmitted, true)
  assert.equal(delivered.at(-1)?.updates.length, 0)
  assert.equal(oldPackets.at(-1)?.updates.length, 1, "unopted legacy window stays full")
  assert.equal(otherPackets.at(-1)?.contentOmitted, true, "other window has its own interest")
  assert.equal(reads, 0, "listed contiguous metadata needs no snapshot")

  // A snapshot captured before the next event must replay that event, not drop it or trust an empty body.
  pause = { arrived: gate(), release: gate() }
  const held = pause
  const promoting = hydrateLive(a)
  await held.arrived.wait
  assert.ok(localContentUnion()?.includes(a), "in-flight snapshot is a reader before hydration")
  await sent(change(a, "arrived after snapshot capture"))
  assert.equal(delivered.at(-1)?.contentOmitted, undefined, "promotion registered before reading")
  held.release.open()
  await promoting
  await until("promotion converges after a snapshot the stream overtook", () =>
    acpStore.get().conversations[a]?.hydrated === true && acpStore.get().conversations[a]?.revision === source.get(a)?.revision)
  sameContent(a)

  await hydrateLive(c)
  acpStore.set({ activeKey: a })
  await syncLocalContent()
  await sent(change(c, "hidden hydrated cache still consumes content"))
  assert.equal(delivered.at(-1)?.contentOmitted, undefined)
  sameContent(c)

  const pane = viewer.openAgentPane("right", { thread: b, tab: b })
  assert.ok(pane)
  await syncLocalContent()
  await sent(change(b, "secondary pane watches independently of the focused conversation"))
  assert.equal(delivered.at(-1)?.contentOmitted, undefined)
  viewer.closePane(pane)
  await syncLocalContent()

  const releaseCopy = transcriptReaders.protect(liveReadingSource(b), "copy-turn")
  await syncLocalContent()
  await sent(change(b, "copy/detail lease has interest without focus or hydration"))
  assert.equal(delivered.at(-1)?.contentOmitted, undefined)
  releaseCopy()
  await syncLocalContent()
  await sent(change(b, "released copy lease becomes metadata-only again"))
  assert.equal(delivered.at(-1)?.contentOmitted, true)

  // A late metadata-only delivery can cross interest registration. It cannot certify hydrated content at that revision.
  pause = { arrived: gate(), release: gate() }
  const omittedRead = pause
  const beforeRevision = acpStore.get().conversations[a]!.revision
  await sent(withoutLiveContent(change(a, "late omitted body must be recaptured")))
  await omittedRead.arrived.wait
  assert.equal(acpStore.get().conversations[a]!.revision, beforeRevision)
  omittedRead.release.open()
  await until("late omitted body snapshot applied", () => acpStore.get().conversations[a]?.revision === source.get(a)?.revision)
  sameContent(a)

  // A history/backpressure invalidation may hide metadata too. Read it, then return the unopened body to listed state.
  const before = source.get(b)!
  source.set(b, { ...before, revision: before.revision! + 1, session: { ...before.session, title: "Metadata recovered after invalidation" } })
  await sent({ type: "live-batch", batch: { id: b, epoch: before.epoch, revision: before.revision! + 1, updates: [], historyChanged: true } })
  await until("invalidation recovers metadata and releases hidden body", () => {
    const current = acpStore.get().conversations[b]
    return current?.kind === "live" && current.session.title === "Metadata recovered after invalidation" && !current.hydrated
  })
  await syncLocalContent()
  assert.ok(!localContentUnion()?.includes(b))

  // A listed Session's turn ends behind content left out: the read it sets off is a change heard, so it's announced,
  // never taken for a quiet load (the packaged run lost a background Thread's "finished" notice to that).
  const toasts: string[] = []
  const unbindNotices = installNotificationEnvironment({
    visibleSubjects: () => new Set(), focused: () => true, now: () => Date.now(), cue: () => {}, toast: (item) => void toasts.push(`${item.kind}:${item.subject.id}:${item.body}`),
    dismissToast: () => {}, desktop: async () => true, dismissDesktop: () => {}, badge: () => {}, schedule: () => () => {}, open: () => {}, announces: () => true,
  })
  // Listed while its first prompt waits (the read a batch without content sets off), then taken through its turn by
  // batches of metadata alone: its prompt waits no longer, so its turn's end is announced.
  const asked: LiveRequest = { id: auditId(799), text: "Background work", attachments: [], status: "queued" }
  const step = async (session: Partial<LiveSnapshot["session"]>, request: LiveRequest, historyChanged: boolean, turnReply?: string) => {
    const prior = source.get(b)!
    const revision = prior.revision! + 1
    source.set(b, { ...prior, revision, session: { ...prior.session, ...session }, requests: [request] })
    await sent({ type: "live-batch", batch: { id: b, epoch: prior.epoch, revision, updates: [], sessionChanges: session, requests: [request], ...(historyChanged && { historyChanged }), ...(turnReply !== undefined && { turnReply }) } })
    assert.equal(delivered.at(-1)?.contentOmitted, true)
    await until(`the listed Session reads ${session.status}`, () => {
      const current = acpStore.get().conversations[b]
      return current?.kind === "live" && current.revision === revision && !current.hydrated
    })
    await syncLocalContent()
    assert.ok(!localContentUnion()?.includes(b))
  }
  await step({ status: "ready" }, asked, true)
  const listed = acpStore.get().conversations[b]
  assert.ok(listed?.kind === "live")
  assert.equal(listed.queued.length, 1, "listed as it waits")
  await step({ status: "running" }, { ...asked, status: "dispatching" }, false)
  await step({ status: "ready", lastStop: "completed" }, { ...asked, status: "completed" }, false, "The background work is done.\n\nDetails follow.")
  await until("its turn's end is announced", () => toasts.some((toast) => toast.startsWith("finished:")))
  assert.ok(toasts.some((toast) => toast.startsWith("finished:") && toast.endsWith("The background work is done.")), `the notice quotes the reply its end carried: ${toasts.join(" | ")}`)
  // What the host puts on a turn's end: the reply's first paragraph, bounded, from its text since the prompt.
  assert.equal(turnReplyOf([{ type: "text", text: "Old turn." }, { type: "user", text: "Go" }, { type: "tool" }, { type: "text", text: "First paragraph\nstill first.\n\nSecond." }]), "First paragraph\nstill first.")
  assert.equal(turnReplyOf([{ type: "user", text: "Go" }, { type: "tool" }]), "")
  assert.equal(turnReplyOf([{ type: "text", text: "x".repeat(1000) }]).length, TURN_REPLY_CHARS)
  unbindNotices()

  // A Session first heard while the window runs (a Fin, another device's Thread) is listed, not kept whole: kept, it
  // joined the watch and took every later batch in full (the packaged run of 2026-11-11 withheld one batch each).
  const late = auditId(703)
  source.set(late, { ...auditSnapshot(0, "codex"), session: { ...auditSnapshot(0, "codex").session, id: late }, threadId: late, sessionId: late, epoch: "fixture-epoch" })
  await sent(change(late, "first heard while the window runs"))
  assert.equal(delivered.at(-1)?.contentOmitted, true)
  await until("a Session first heard is listed with its metadata, its body let go", () => {
    const current = acpStore.get().conversations[late]
    return current?.kind === "live" && current.revision === source.get(late)?.revision && !current.hydrated
  })
  await syncLocalContent()
  assert.ok(!localContentUnion()?.includes(late), "a Session only listed is outside the watch")
  await sent(change(late, "its next batch stays without content"))
  assert.equal(delivered.at(-1)?.contentOmitted, true)
  await until("the listed Session follows its metadata", () => acpStore.get().conversations[late]?.revision === source.get(late)?.revision)
  assert.equal(acpStore.get().conversations[late]?.hydrated, false)

  // Real disconnect/re-attach rejects an old read and requires fresh interest plus a new authoritative snapshot.
  pause = { arrived: gate(), release: gate() }
  const disconnectedRead = pause
  const oldRead = hydrateLive(a)
  await disconnectedRead.arrived.wait
  const retired = generation
  close()
  resetLocalContent()
  generation = randomUUID(); sequence = 0
  close = attach()
  await until("replacement stream ready", () => ready === 4)
  await assert.rejects(invokeRuntime(socket, client, LOCAL_CONTENT_CHANNEL, [{ generation: retired, sequence: 999, conversations: [] }]), /stream changed/)
  change(a, "content missed while disconnected")
  disconnectedRead.release.open()
  assert.equal(await oldRead, false, "old snapshot cannot establish new generation's view")
  await hydrateLive(a)
  sameContent(a)
  await sent(change(a, "new generation follows later content"))
  sameContent(a)

  // Reordered full-set replacements cannot remove a later watch.
  const high = sequence + 2
  await invokeRuntime(socket, client, LOCAL_CONTENT_CHANNEL, [{ generation, sequence: high, conversations: [a] }])
  await invokeRuntime(socket, client, LOCAL_CONTENT_CHANNEL, [{ generation, sequence: high - 1, conversations: [] }])
  sequence = high
  await sent(change(a, "stale removal cannot overtake promotion"))
  assert.equal(delivered.at(-1)?.contentOmitted, undefined)
  sameContent(a)

  const remote = change(b, "remote events remain full even without local content interest")
  const packets = delivered.length
  host.conversationEvent(encodeRuntimeEvent(remote))
  await until("remote event delivered", () => delivered.length > packets)
  assert.equal(delivered.at(-1)?.contentOmitted, undefined)
  assert.equal(delivered.at(-1)?.updates.length, 1)
  await assert.rejects(invokeRuntime(socket, client, LOCAL_CONTENT_CHANNEL,
    [{ generation, sequence: ++sequence, conversations: Array.from({ length: LOCAL_CONTENT_LIMIT + 1 }, () => a) }]),
  "an oversized union is refused before it changes delivery")
  await invokeRuntime(socket, client, LOCAL_CONTENT_CHANNEL, [{ generation, sequence: ++sequence, conversations: null }])
  await sent(change(b, "explicit full-delivery fallback retains unwatched content"))
  assert.equal(delivered.at(-1)?.contentOmitted, undefined)
  console.log(JSON.stringify({ passed: true, windows: 3, delivered: delivered.length, reads,
    cases: ["listed metadata", "legacy and independent windows", "snapshot promotion with buffered content", "hidden hydrated cache", "secondary pane", "copy/detail leases", "late omitted body", "history invalidation", "listed turn end announced", "session first heard", "reconnect stale snapshot and generation", "out-of-order watch removal", "remote unchanged", "bounded inputs and full fallback"] }))
} finally {
  stop(); close(); closeLegacy(); closeOther()
  liveRead.mock.restore()
  delete bridge.watchLiveContent
  host.close()
  await removeScratch(root)
}
