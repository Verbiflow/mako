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
import { historyChangedNotice } from "@mako/host/transport/gateway"
import { encodeRuntimeEvent, decodeRuntimeEvent } from "@mako/host/contracts/runtime-value"
import { LOCAL_CONTENT_CHANNEL, LocalContentReceiptSchema } from "@mako/host/contracts/local-content-watch"
import { ROSTER_LIVE_FORM } from "@mako/protocol/live-form"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { LiveBatch, LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { auditId, auditSnapshot } from "./performance-audit-fixtures"
import { removeScratch } from "./lib/scratch-processes.mjs"

Object.defineProperty(globalThis, "window", { value: {}, configurable: true })
Object.assign(globalThis, { requestAnimationFrame: (run: () => void) => setTimeout(run, 16), cancelAnimationFrame: clearTimeout })
const { installMockBridge } = await import("../src/dev/mock-bridge")
installMockBridge()
const { getMako } = await import("../src/lib/bridge")
const { acpStore } = await import("../src/state/acp-state")
const { applyLiveSnapshot, applyLiveBatch, unloadLive } = await import("../src/state/live-recovery")
const { localContentUnion, watchLocalContent, syncLocalContent } = await import("../src/state/local-content-watch")
const { transcriptReaders, liveReadingSource } = await import("../src/state/transcript-reading")
const { viewer } = await import("../src/state/viewer")
const { AudioFeedback } = await import("../src/lib/audio-feedback")
mock.method(AudioFeedback.prototype, "play", async () => {})
const selected = process.argv[process.argv.indexOf("--case") + 1]
const cases = selected === "r1" ? ["r1"] : selected === "r2" ? ["r2"] : ["r1", "r2", "pane", "size-lease", "released-watch", "full", "remote"]
const root = await mkdtemp(join(tmpdir(), "mako-content-recovery-"))
const socket = join(root, "host.sock"), client = randomUUID(), legacy = randomUUID(), generation = randomUUID()
const source = new Map<string, LiveSnapshot>()
const cold = auditId(810), copying = auditId(811), paneOnly = auditId(812), remote = auditId(813), sizeLease = auditId(814)
const releasedWatch = auditId(815), full = auditId(816)
for (const id of [cold, copying, paneOnly, remote, sizeLease, releasedWatch, full]) {
  const seed = auditSnapshot(1, "codex")
  source.set(id, { ...seed, session: { ...seed.session, id, status: "ready" }, threadId: id, sessionId: id, epoch: "recovery-fixture" })
}
function gate() {
  let open = () => {}
  const wait = new Promise<void>(resolve => { open = resolve })
  return { wait, open }
}
const held = new Map<string, { arrived: ReturnType<typeof gate>; release: ReturnType<typeof gate> }>()
const until = async (why: string, check: () => boolean) => {
  const end = Date.now() + 5000
  while (!check()) { assert.ok(Date.now() < end, why); await tick() }
}
let reads = 0, sequence = 0, ready = 0
const host = await startWebHost(socket, async (channel, args) => {
  assert.equal(channel, "mako:live-read")
  const id = z.string().parse(args[0]), snapshot = structuredClone(source.get(id))
  assert.ok(snapshot)
  reads++
  const pause = held.get(id)
  if (pause) { held.delete(id); pause.arrived.open(); await pause.release.wait }
  const data = JSON.stringify(snapshot)
  return JSON.stringify({ record: randomUUID(), offset: 0, total: data.length, data, next: null })
}, async () => new Response(null, { status: 404 }))
const packets: LiveBatch[] = [], oldPackets: LiveBatch[] = []
const close = subscribeRuntime(socket, client, packet => {
  if (packet.channel === "ready") { ready++; return }
  const event = decodeRuntimeEvent<HostEvent>(packet.payload)
  assert.equal(event.type, "live-batch")
  packets.push(event.batch)
  applyLiveBatch(event.batch)
}, () => {}, { history: true, live: ROSTER_LIVE_FORM, eventLimit: 64 * 1024, contentGeneration: generation })
const closeLegacy = subscribeRuntime(socket, legacy, packet => {
  if (packet.channel === "ready") { ready++; return }
  const event = decodeRuntimeEvent<HostEvent>(packet.payload)
  assert.equal(event.type, "live-batch")
  oldPackets.push(event.batch)
}, () => {}, { history: true, eventLimit: 64 * 1024 })
const bridge = getMako()
bridge.watchLiveContent = async conversations => {
  const receipt = LocalContentReceiptSchema.parse(await invokeRuntime(socket, client, LOCAL_CONTENT_CHANNEL,
    [{ generation, sequence: ++sequence, conversations }]))
  return receipt.generation
}
const chunk = z.object({ record: z.uuid(), offset: z.number(), total: z.number(), data: z.string(), next: z.null() })
const reading = mock.method(bridge, "liveRead", async (...args: Parameters<typeof bridge.liveRead>) =>
  chunk.parse(await invokeRuntime(socket, client, "mako:live-read", args)))
let stop = () => {}
const releases: (() => void)[] = []
function actualNotice(id: string, revision: number): Extract<HostEvent, { type: "live-batch" }> {
  const notice = historyChangedNotice(encodeRuntimeEvent({ type: "live-batch", batch: { id, epoch: "recovery-fixture", revision, updates: [] } }))
  assert.ok(notice)
  const event = decodeRuntimeEvent<HostEvent>(notice.payload)
  assert.equal(event.type, "live-batch")
  return event
}
function current(id: string) {
  const value = acpStore.get().conversations[id]
  assert.equal(value?.kind, "live")
  return value
}
async function snapshotSettled(id: string, revision: number) {
  await until("authoritative snapshot revision reached", () => acpStore.get().conversations[id]?.revision === revision)
  // Cross a task boundary, including hydrateLive's finally/release path, without clock sleeps.
  await tick(); await tick()
}
try {
  await until("both socket streams attached", () => ready === 2)
  acpStore.set({ conversations: {}, activeKey: null })
  for (const snapshot of source.values()) { applyLiveSnapshot(snapshot); assert.equal(unloadLive(snapshot.session.id), true) }
  stop = watchLocalContent()
  await syncLocalContent()
  if (cases.includes("r1")) {
    const snapshot = source.get(cold)!
    const title = "Real size fallback: " + "metadata ".repeat(9000)
    source.set(cold, { ...snapshot, revision: 2, session: { ...snapshot.session, title } })
    host.event({ type: "live-batch", batch: { id: cold, epoch: snapshot.epoch, revision: 2, updates: [], sessionChanges: { title } } })
    await snapshotSettled(cold, 2)
    assert.equal(current(cold).session.title, title)
    assert.equal(current(cold).hydrated, false, "actual server size fallback must release a genuinely cold temporary body")
    await syncLocalContent()
    assert.ok(!localContentUnion()?.includes(cold), "real fallback must not widen the cold watch")
    const notice = packets.find(batch => batch.id === cold)
    assert.equal(notice?.historyChanged, true, "server emitted an actual size fallback")
    assert.equal(notice?.contentOmitted, true, "opted local fallback carries omission provenance")
    await until("legacy fallback arrived", () => oldPackets.some(batch => batch.id === cold))
    const legacyNotice = oldPackets.find(batch => batch.id === cold)
    assert.equal(legacyNotice?.historyChanged, true)
    assert.equal(legacyNotice?.contentOmitted, undefined, "legacy fallback shape stays unchanged")
  }
  for (const kind of cases.filter(value => value === "r2" || value === "pane" || value === "size-lease")) {
    const id = kind === "r2" ? copying : kind === "pane" ? paneOnly : sizeLease
    const snapshot = source.get(id)!
    const title = "Recovered while a new reader waits" + (kind === "size-lease" ? " metadata".repeat(9000) : "")
    source.set(id, { ...snapshot, revision: 2, session: { ...snapshot.session, title } })
    const pause = { arrived: gate(), release: gate() }
    held.set(id, pause)
    releases.push(pause.release.open)
    if (kind === "size-lease") {
      host.event({ type: "live-batch", batch: { id, epoch: snapshot.epoch, revision: 2, updates: [], sessionChanges: { title } } })
    } else {
      // The real generator + encoder/decoder supplies the notice. Its marked control isolates retention from R1.
      const notice = actualNotice(id, 2)
      host.event({ ...notice, batch: { ...notice.batch, contentOmitted: true } })
    }
    await pause.arrived.wait
    let releaseOne = () => {}, releaseLast = () => {}
    if (kind !== "pane") {
      releaseOne = transcriptReaders.protect(liveReadingSource(id), "copy-turn")
      releaseLast = transcriptReaders.protect(liveReadingSource(id), "detail-turn")
    } else {
      const pane = viewer.openAgentPane("right", { thread: id, tab: id })
      assert.ok(pane)
      releaseLast = () => viewer.closePane(pane)
    }
    releases.push(releaseOne, releaseLast)
    // A later content revision overtakes the held snapshot; all recovery guards must survive cleanup.
    const before = source.get(id)!
    source.set(id, { ...before, revision: 3, blocks: [...before.blocks, { type: "text", id: "later", text: "Content after the held capture" }] })
    await syncLocalContent()
    host.event({ type: "live-batch", batch: { id, epoch: before.epoch, revision: 3, updates: [{ kind: "text", id: "later", text: "Content after the held capture" }] } })
    await until("late content reached the receiver", () => packets.some(batch => batch.id === id && batch.revision === 3))
    pause.release.open()
    await snapshotSettled(id, 3)
    assert.equal(current(id).hydrated, true, "independent reader acquired during recovery must retain the recovered body")
    assert.deepEqual(current(id).blocks, source.get(id)?.blocks, "buffered content and snapshot remain coherent")
    assert.equal(unloadLive(id), false, "all unload callers respect independent body readers")
    releaseOne()
    await tick(); await tick()
    assert.equal(current(id).hydrated, true, "one lease ending cannot release another reader's input")
    releaseLast()
    await until("last interest releases only the temporary body", () => !acpStore.get().conversations[id]?.hydrated)
    await syncLocalContent()
    assert.ok(!localContentUnion()?.includes(id))
    assert.equal(current(id).revision, 3, "cleanup retains metadata revision")
    assert.equal(current(id).session.title, title)
    if (kind === "size-lease") {
      assert.equal(packets.find(batch => batch.id === id)?.historyChanged, true)
      assert.equal(packets.find(batch => batch.id === id)?.contentOmitted, true)
    }
  }
  if (cases.includes("released-watch")) {
    const release = transcriptReaders.protect(liveReadingSource(releasedWatch), "earlier-operation")
    releases.push(release)
    await syncLocalContent()
    const snapshot = source.get(releasedWatch)!, title = "Watched when sent: " + "metadata ".repeat(9000)
    source.set(releasedWatch, { ...snapshot, revision: 2, session: { ...snapshot.session, title } })
    host.event({ type: "live-batch", batch: { id: releasedWatch, epoch: snapshot.epoch, revision: 2, updates: [], sessionChanges: { title } } })
    release() // The notice is on its socket, but the receiver has not run yet.
    await snapshotSettled(releasedWatch, 2)
    assert.equal(packets.find(batch => batch.id === releasedWatch)?.contentOmitted, true)
    assert.equal(current(releasedWatch).hydrated, false, "a watch retired before arrival cannot turn fallback into permanent residency")
  }
  for (const kind of cases.filter(value => value === "remote" || value === "full")) {
    const id = kind === "remote" ? remote : full
    const snapshot = source.get(id)!, title = `${kind} unchanged: ` + "metadata ".repeat(9000)
    source.set(id, { ...snapshot, revision: 2, session: { ...snapshot.session, title } })
    const event: Extract<HostEvent, { type: "live-batch" }> = { type: "live-batch", batch: { id, epoch: snapshot.epoch, revision: 2, updates: [], sessionChanges: { title } } }
    if (kind === "remote") host.conversationEvent(encodeRuntimeEvent(event))
    else { await bridge.watchLiveContent(null); host.event(event) }
    await snapshotSettled(id, 2)
    assert.equal(packets.find(batch => batch.id === id)?.contentOmitted, undefined, `${kind} fallback stays unmarked`)
    assert.equal(current(id).hydrated, true, `${kind} recovery retains its existing behavior`)
  }
  console.log(JSON.stringify({ passed: true, cases, reads, scope: "real size-fallback/generator/encoding/socket/production reducers and actual leases; no Electron/provider" }))
} finally {
  for (const release of releases) release()
  for (const pause of held.values()) pause.release.open()
  stop(); close(); closeLegacy()
  reading.mock.restore()
  delete bridge.watchLiveContent
  host.close()
  await removeScratch(root)
}
